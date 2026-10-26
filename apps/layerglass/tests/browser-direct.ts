import { fixtureAddress } from '../../../tests/http.ts';
import type { Route, BrowserContext } from 'playwright';
import type { ServerResponse } from 'node:http';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium, webkit } from 'playwright';
import { waitForPlayer } from './player-page.ts';

const base = process.env.VIEWER_URL || 'http://127.0.0.1:8080';
const frontend = new URL(base).origin;
let jpeg: Buffer;
let mode = 'ready';
const requests: Array<string> = [];
const streams = new Set<{ path: string; response: ServerResponse }>();
const identity = {
  moonraker_version: 'v0.9.3-fixture',
  api_version: [1, 5, 0],
  klippy_connected: true,
  klippy_state: 'ready',
  components: ['klippy_apis', 'webcams'],
};
const camera = (uid: string, name: string, path: string) => ({
  uid,
  name,
  enabled: true,
  service: 'mjpegstreamer',
  stream_url: path,
});
const server = createServer((request, response) => {
  const path = new URL(request.url!, 'http://fixture.invalid').pathname;
  requests.push(path);
  if (mode !== 'no-cors' && request.headers.origin === frontend)
    response.setHeader('Access-Control-Allow-Origin', frontend);
  response.setHeader('Vary', 'Origin');
  response.setHeader('Cache-Control', 'no-store');
  const reply = (result: unknown) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ result }));
  };
  if (path === '/server/info') return reply({ ...identity, klippy_connected: mode !== 'disconnected' });
  if (path === '/printer/info')
    return reply({ state: 'ready', hostname: 'generated-klipper', software_version: 'v0.13.0-fixture' });
  if (path === '/server/webcams/list')
    return reply({
      webcams: [
        camera('chamber', 'Print chamber', mode === 'redirect' ? '/redirect' : '/webcam/chamber'),
        camera('toolhead', 'Toolhead', '/webcam/toolhead'),
        camera('other-host', 'Rejected external webcam', 'https://unselected.invalid/camera'),
        { ...camera('webrtc', 'Unsupported protocol', '/webcam/webrtc'), service: 'webrtc-camerastreamer' },
      ],
    });
  if (path === '/redirect') {
    response.statusCode = 302;
    response.setHeader('Location', controllerOrigin.replace('127.0.0.1', 'localhost') + '/must-not-follow');
    return response.end();
  }
  if (path.startsWith('/webcam/')) {
    response.setHeader('Content-Type', 'multipart/x-mixed-replace; boundary=camera');
    response.flushHeaders();
    const part = Buffer.concat([
      Buffer.from(`--camera\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`),
      jpeg,
      Buffer.from('\r\n'),
    ]);
    const connection = { path, response };
    streams.add(connection);
    response.write(part);
    const timer = setInterval(() => response.write(part), 250);
    response.on('close', () => {
      clearInterval(timer);
      streams.delete(connection);
    });
    return;
  }
  response.statusCode = 404;
  response.end('Not a printer endpoint');
});
await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve));
const controllerOrigin = `http://127.0.0.1:${fixtureAddress(server).port}`;

async function prepare(context: BrowserContext) {
  // Route fulfillment represents a hosted origin in Chromium's address-space
  // checks. Grant only this fixture frontend permission to reach its loopback
  // controller; production still uses the browser's real permission prompt.
  if (context.browser()!.browserType().name() === 'chromium') {
    await context.grantPermissions(['local-network-access'], { origin: frontend });
  }
  const page = await context.newPage();
  const errors: Array<unknown> = [];
  const forbidden: Array<string> = [];
  const transportErrors: Array<{ url: unknown; error: unknown } | unknown> = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('requestfailed', (request) =>
    transportErrors.push({ url: request.url(), error: request.failure()?.errorText }),
  );
  page.on('console', (entry) => {
    if (entry.type() === 'error') transportErrors.push(entry.text());
  });
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin === frontend && (url.pathname.startsWith('/api/') || url.pathname.startsWith('/replay/')))
      forbidden.push(url.pathname);
  });
  await page.route(base + '/', async (route: Route) => {
    const response = await route.fetch();
    const headers = { ...response.headers() };
    headers['content-security-policy'] =
      `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob: ${controllerOrigin} ${controllerOrigin.replace('127.0.0.1', 'localhost')}; media-src 'self' blob:; connect-src 'self' ${controllerOrigin} ${controllerOrigin.replace('127.0.0.1', 'localhost')}; worker-src 'self' blob:;`;
    await route.fulfill({
      response,
      headers,
      body: (await response.text()).replace(
        'name="layerglass-backend" content="python"',
        'name="layerglass-backend" content="choose"',
      ),
    });
  });
  await page.route(base + '/api/**', (route: Route) => route.abort());
  await page.route(base + '/replay/**', (route: Route) => route.abort());
  return { page, errors, forbidden, transportErrors };
}

try {
  for (const [name, engine] of Object.entries({ chromium, webkit })) {
    if (process.env.BROWSER && process.env.BROWSER !== name) continue;
    mode = 'ready';
    requests.length = 0;
    const browser = await engine.launch({ headless: true });
    try {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        serviceWorkers: 'block',
      });
      const { page, errors, forbidden, transportErrors } = await prepare(context);
      if (name === 'webkit') {
        await page.goto(base);
        assert.equal(await page.locator('[data-backend-choice="direct"]').isDisabled(), true);
        assert.match(
          (await page.locator('[data-backend-choice="direct"]').textContent())!,
          /Safari and iPhone.*Docker/,
        );
        assert.equal(requests.length, 0, 'Unsupported WebKit must not probe or open a stream.');
        assert.deepEqual(errors, []);
        await context.close();
        const saved = await browser.newContext({ serviceWorkers: 'block' });
        await saved.addInitScript(
          ({ origin, controller }) => {
            if (location.origin === origin && !sessionStorage.getItem('direct-fixture-seeded')) {
              localStorage.setItem(
                'layerglass-backend',
                JSON.stringify({ type: 'direct', profile: 'moonraker', url: controller }),
              );
              sessionStorage.setItem('direct-fixture-seeded', '1');
            }
          },
          { origin: frontend, controller: controllerOrigin },
        );
        const savedCase = await prepare(saved);
        await savedCase.page.goto(base);
        await waitForPlayer(
          savedCase.page,
          ({ app }) => app.status?.state === 'unsupported' && app.directStream === null,
        );
        assert.equal(await savedCase.page.locator('#loader').isVisible(), false);
        assert.match(
          (await savedCase.page.locator('#overlay-subtitle').textContent())!,
          /Safari and iPhone.*Docker/,
        );
        await savedCase.page.locator('#options-button').click();
        await savedCase.page.locator('[data-settings-target="backends"]').click();
        assert.equal(await savedCase.page.locator('[data-backend-select="direct"]').isDisabled(), true);
        await Promise.all([
          savedCase.page.waitForEvent('domcontentloaded'),
          savedCase.page.locator('[data-backend-select="demo"]').click(),
        ]);
        await waitForPlayer(
          savedCase.page,
          ({ app }) => app.pageReplay.session?.kind === 'file' && app.video.currentTime > 1,
        );
        assert.equal(requests.length, 0);
        assert.deepEqual(savedCase.forbidden, []);
        assert.deepEqual(savedCase.errors, []);
        await saved.close();
        console.log(
          'webkit: direct MJPEG explicitly unavailable, zero printer requests; old preference recovers to demo',
        );
        continue;
      }
      // Generate real JPEG media without a file, external camera or backend API.
      jpeg = Buffer.from(
        await page.evaluate(() => {
          const canvas = document.createElement('canvas');
          canvas.width = 320;
          canvas.height = 180;
          const paint = canvas.getContext('2d');
          paint!.fillStyle = '#172c20';
          paint!.fillRect(0, 0, 320, 180);
          paint!.fillStyle = '#b6ed83';
          paint!.fillRect(40, 40, 240, 100);
          return canvas.toDataURL('image/jpeg').split(',')[1]!;
        }),
        'base64',
      );
      await page.goto(base);
      await page.locator('[data-backend-choice="direct"]').click();
      assert.match(
        (await page.locator('[data-connection-intro]').textContent())!,
        /Klipper.*Moonraker.*Live camera only.*Bambu.*Docker/,
      );
      await page.locator('#backend-connect-url').fill(controllerOrigin + '/webcam/chamber');
      await page.locator('.backend-connect-form [type="submit"]').click();
      await page.locator('.backend-connect-error').waitFor();
      assert.equal(requests.length, 0, 'A generic stream URL is rejected before any device request.');
      await page.locator('#backend-connect-url').fill(controllerOrigin);
      await page.locator('.backend-connect-form [type="submit"]').click();
      try {
        await page.locator('#backend-picker').waitFor({ state: 'detached', timeout: 12000 });
      } catch (error) {
        console.error('Direct fixture connection:', {
          controllerOrigin,
          requests,
          errors,
          transportErrors,
          message: await page.locator('.backend-connect-error').textContent(),
        });
        throw error;
      }
      try {
        await waitForPlayer(
          page,
          ({ app }) =>
            app.directStream &&
            !app.directStream?.['failed'] &&
            document.querySelector<HTMLImageElement>('#jpeg')!.naturalWidth === 320 &&
            document.querySelector<HTMLElementTagNameMap['printer-loading']>('#overlay')!.hidden,
          null,
          { timeout: 20000 },
        );
      } catch (error) {
        console.error('Direct fixture playback:', {
          name,
          requests,
          errors,
          transportErrors,
          runtime: await page.evaluate(async () => {
            const app = await import('/static/player.js');
            const image = document.querySelector<HTMLImageElement>('#jpeg');
            return {
              status: app.status,
              failed: app.directStream?.['failed'],
              failure: app.directStream?.failure,
              contentType: app.directStream?.contentType,
              pending: app.directStream?.['pending'],
              current: app.directStream?.['current'],
              src: image!.src,
              width: image!.naturalWidth,
              overlay: document.querySelector<HTMLElementTagNameMap['printer-loading']>('#overlay')!.hidden,
            };
          }),
        });
        throw error;
      }
      assert.equal(await page.locator('video').count(), 1);
      assert.equal(await page.locator('video').evaluate((video: HTMLVideoElement) => video.currentSrc), '');
      assert.equal(await page.locator('#replay-controls').isVisible(), false);
      assert.equal(await page.locator('#pause-button').isVisible(), false);
      assert.equal(await page.locator('#cast-button').isDisabled(), true);
      assert.equal(
        await page.evaluate(async () => (await import('/static/player.js')).pageReplay.session),
        null,
      );
      assert.equal(
        await page.evaluate(() => JSON.parse(localStorage.getItem('layerglass-backend')!).type),
        'direct',
      );
      await page.waitForTimeout(1500);
      assert.equal(
        requests.filter((path) => path === '/webcam/chamber').length,
        1,
        'Frames arrive on one continuing HTTP response.',
      );
      assert.equal(
        requests.filter((path) => path === '/server/info').length,
        2,
        'Only explicit selection and page initialization verify identity.',
      );
      await page.evaluate(async () => {
        window.previousDirectStream = (await import('/static/player.js')).directStream;
      });
      await page.locator('#options-button').click();
      await page.locator('#refresh-button').click();
      await waitForPlayer(
        page,
        ({ app }) =>
          app.directStream &&
          app.directStream !== window.previousDirectStream &&
          !app.directStream?.['failed'] &&
          document.querySelector<HTMLImageElement>('#jpeg')!.naturalWidth === 320 &&
          document.querySelector<HTMLElementTagNameMap['printer-loading']>('#overlay')!.hidden,
      );
      assert.equal(
        requests.filter((path) => path === '/server/info').length,
        3,
        'Root refresh rechecks the approved controller once.',
      );
      assert.equal(
        requests.filter((path) => path === '/webcam/chamber').length,
        2,
        'Root refresh reopens the direct camera once.',
      );
      await page.locator('#options-button').click();
      await page.locator('#printers-button').click();
      assert.equal(await page.locator('printer-item').count(), 2);
      assert.equal(await page.locator('#scan-button').isVisible(), false);
      assert.equal(await page.locator('.printer-access:visible').count(), 0);
      assert.equal(await page.locator('.printer-forget:visible').count(), 0);
      await page.getByRole('button', { name: 'View Toolhead', exact: true }).click();
      await waitForPlayer(
        page,
        ({ app }) =>
          app.status?.mjpeg_url!.endsWith('/webcam/toolhead') &&
          document.querySelector<HTMLElementTagNameMap['printer-loading']>('#overlay')!.hidden,
      );
      await page.waitForFunction(
        () => document.querySelector<HTMLImageElement>('#jpeg')!.naturalWidth === 320,
      );
      const switchDeadline = Date.now() + 2000;
      while (
        [...streams].some((stream) => stream.path !== '/webcam/toolhead') &&
        Date.now() < switchDeadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.deepEqual(
        [...streams].map((stream) => stream.path),
        ['/webcam/toolhead'],
        'Switch aborts the previous stream.',
      );
      await page.evaluate(async () => {
        const { playerTools } = await import('/static/player.js');
        playerTools.openMenu(100, 100);
        playerTools.showStats(true);
      });
      assert.equal(await page.locator('[data-player-action="mini"]').isVisible(), false);
      assert.equal(await page.locator('[data-stat="Video delivery"]').textContent(), 'MJPEG stream');
      const beforeRetry = requests.filter((path) => path === '/webcam/toolhead').length;
      for (const connection of streams) connection.response.destroy();
      await page.waitForTimeout(1800);
      await waitForPlayer(
        page,
        ({ app }) =>
          !app.directStream?.['failed'] &&
          document.querySelector<HTMLElementTagNameMap['printer-loading']>('#overlay')!.hidden,
      );
      assert.equal(requests.filter((path) => path === '/webcam/toolhead').length, beforeRetry + 1);
      await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, value: true });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await waitForPlayer(page, ({ app }) => app.directStream === null);
      await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, value: false });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await waitForPlayer(
        page,
        ({ app }) =>
          app.directStream &&
          document.querySelector<HTMLElementTagNameMap['printer-loading']>('#overlay')!.hidden,
      );
      await page.reload();
      await waitForPlayer(
        page,
        ({ app }) =>
          app.directStream &&
          document.querySelector<HTMLElementTagNameMap['printer-loading']>('#overlay')!.hidden,
      );
      assert.deepEqual(forbidden, []);
      assert.deepEqual(errors, []);
      await context.close();

      mode = 'no-cors';
      requests.length = 0;
      const denied = await browser.newContext({ serviceWorkers: 'block' });
      const deniedCase = await prepare(denied);
      await deniedCase.page.goto(base);
      await deniedCase.page.locator('[data-backend-choice="direct"]').click();
      await deniedCase.page.locator('#backend-connect-url').fill(controllerOrigin);
      await deniedCase.page.locator('.backend-connect-form [type="submit"]').click();
      await deniedCase.page.locator('.backend-connect-error').waitFor();
      assert.match(
        (await deniedCase.page.locator('.backend-connect-error').textContent())!,
        /HTTPS, CORS and trusted local access/,
      );
      assert.equal(await deniedCase.page.evaluate(() => localStorage.getItem('layerglass-backend')), null);
      assert.equal(requests.length, 1);
      assert.deepEqual(deniedCase.errors, []);
      await denied.close();

      mode = 'redirect';
      requests.length = 0;
      const redirected = await browser.newContext({ serviceWorkers: 'block' });
      const redirectCase = await prepare(redirected);
      await redirectCase.page.goto(base);
      await redirectCase.page.locator('[data-backend-choice="direct"]').click();
      await redirectCase.page.locator('#backend-connect-url').fill(controllerOrigin);
      await redirectCase.page.locator('.backend-connect-form [type="submit"]').click();
      await redirectCase.page.locator('#backend-picker').waitFor({ state: 'detached' });
      await waitForPlayer(redirectCase.page, ({ app }) => app.directStream?.['failed']);
      assert.equal(requests.filter((path) => path === '/must-not-follow').length, 0);
      assert.equal(await redirectCase.page.locator('#overlay').isVisible(), true);
      assert.deepEqual(redirectCase.forbidden, []);
      assert.deepEqual(redirectCase.errors, []);
      await redirected.close();
      console.log(
        `${name}: verified direct Klipper/Moonraker, one MJPEG connection, live-only controls, camera switch/reconnect, CORS and redirect rejection passed`,
      );
    } finally {
      await browser.close();
    }
  }
} finally {
  for (const connection of streams) connection.response.destroy();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
