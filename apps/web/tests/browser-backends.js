import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import fs from 'node:fs/promises';
import { waitForPlayer } from './player-page.js';

const base = process.env.VIEWER_URL || 'http://127.0.0.1:8080';
const chosen = process.env.BROWSER;

for (const [name, engine] of Object.entries({ chromium, webkit })) {
  if (chosen && chosen !== name) continue;
  const browser = await engine.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
    const page = await context.newPage();
    const requests = []; const errors = []; const failed = [];
    let phase = 'chooser';
    page.on('request', request => requests.push(new URL(request.url()).pathname));
    page.on('pageerror', error => errors.push({ phase, message: error.message, stack: error.stack }));
    page.on('requestfailed', request => failed.push({ phase, url: request.url(), error: request.failure()?.errorText }));
    // Any accidental Python dependency fails immediately in browser-only mode.
    await page.route('**/api/**', route => route.abort());
    await page.route('**/replay/**', route => route.abort());
    // Match the standalone build with no host-provided backend or saved choice.
    await page.route(base + '/', async route => {
      const response = await route.fetch();
      await route.fulfill({ response, body: (await response.text()).replace(
        'name="layerglass-backend" content="python"', 'name="layerglass-backend" content="choose"') });
    });
    await page.goto(base);
    await page.getByRole('heading', { name: 'Choose your backend' }).waitFor();
    assert.equal(await page.locator('video').count(), 0);
    assert.equal(requests.some(path => path.startsWith('/api/') || path.startsWith('/replay/') || path.endsWith('.mp4') || path.includes('hls.min')), false,
      'A fresh standalone visit must not select a backend or load the media pipeline.');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: `/app/test-results/backend-chooser-${name}.png` });
    await page.locator('[data-backend-choice="docker"]').click();
    await page.locator('#backend-connect-url').fill(base + '/not-an-origin');
    await page.locator('.backend-connect-form [type="submit"]').click();
    await page.locator('.backend-connect-error').waitFor();
    assert.equal(await page.evaluate(() => localStorage.getItem('layerglass-backend')), null);
    assert.equal(requests.some(path => path.startsWith('/api/')), false);
    await page.route(base + '/api/backend', route => route.fulfill({ json: { id: 'unrelated', protocol_version: 1 } }));
    await page.locator('#backend-connect-url').fill(base);
    await page.locator('.backend-connect-form [type="submit"]').click();
    await page.waitForFunction(() => document.querySelector('.backend-connect-error').textContent.includes('not a compatible'));
    assert.equal(await page.evaluate(() => localStorage.getItem('layerglass-backend')), null);
    await page.locator('[data-backend-back]').click();
    requests.length = 0;
    await page.locator('[data-backend-choice="demo"]').click();
    phase = 'initial demo';
    await page.locator('#backend-picker').waitFor({ state: 'detached' });
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('layerglass-backend'))), { type: 'demo' });
    await waitForPlayer(page, ({ app }) => app.video.currentTime > 0 && app.pageReplay.session?.kind === 'file');
    await page.reload();
    phase = 'saved demo';
    assert.equal(await page.locator('#backend-picker').count(), 0, 'Saved choices bypass onboarding.');
    await waitForPlayer(page, ({ app }) => app.video.currentTime > 2 && app.video.readyState >= 2 &&
      app.pageReplay.session?.kind === 'file' && document.querySelector('#overlay').hidden, null, { timeout: 15000 });
    assert.equal(await page.locator('video').count(), 1);
    assert.equal(await page.locator('#camera-name').textContent(), 'Demo printer');
    assert.equal(await page.locator('#cast-button').isDisabled(), true);
    await page.locator('#options-button').click();
    assert.equal(await page.locator('#printers-button').isVisible(), false);
    await page.locator('[data-settings-target="connection"]').click();
    assert.equal(await page.locator('#backend-type').inputValue(), 'demo');
    assert.match(await page.locator('#backend-capabilities').textContent(), /No LAN discovery/);
    assert.equal(await page.locator('#restart-button').isVisible(), false);
    await page.evaluate(async () => {
      const app = await import('/static/player.js');
      app.playerChrome.options(false);
      app.playerTools.showStats(true);
      app.pageReplay.seek(0.5);
    });
    await waitForPlayer(page, ({ app }) => app.video.currentTime > 0.5 && app.video.currentTime < 4 && !app.video.seeking);
    assert.equal(await page.locator('[data-stat="Media pipeline"]').textContent(), 'Native video');
    await page.waitForFunction(() => document.querySelector('[data-stat="Connection"]')?.textContent === 'connected');
    assert.equal(requests.filter(path => path.startsWith('/api/') || path.startsWith('/replay/')).length, 0);
    await page.evaluate(async () => {
      const app = await import('/static/player.js');
      app.pageReplay.goLive();
      app.pageReplay.togglePause();
    });
    assert.equal(await page.locator('video').evaluate(video => video.paused), true);
    // A local user file reuses the same decoder and loses simulated telemetry.
    await page.locator('#options-button').click();
    const demoFile = await fs.readFile(new URL('../src/demo/printer.mp4', import.meta.url));
    phase = 'local file';
    await page.locator('#local-media').setInputFiles({ name: 'local-print.mp4', mimeType: 'video/mp4', buffer: demoFile });
    await waitForPlayer(page, ({ app }) => app.video.currentSrc.startsWith('blob:') && app.video.currentTime > 0 && !app.video.paused);
    assert.equal(await page.locator('#camera-name').textContent(), 'Local video');
    assert.equal(await page.locator('video').count(), 1);
    assert.equal(requests.filter(path => path.startsWith('/api/') || path.startsWith('/replay/')).length, 0);
    if (errors.length) console.error(name, { errors, failed });
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`${name}: first-visit chooser, validation, saved demo/local file, native decoder, replay and settings passed without Python requests`);

    const blocked = await browser.newContext({ serviceWorkers: 'block' });
    await blocked.addInitScript(() => Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Blocked', 'SecurityError'); } }));
    const blockedPage = await blocked.newPage();
    await blockedPage.route(base + '/', async route => {
      const response = await route.fetch();
      await route.fulfill({ response, body: (await response.text()).replace(
        'name="layerglass-backend" content="python"', 'name="layerglass-backend" content="choose"') });
    });
    await blockedPage.goto(base);
    await blockedPage.locator('[data-backend-choice="demo"]').click();
    await blockedPage.locator('#backend-picker').waitFor({ state: 'detached' });
    await waitForPlayer(blockedPage, ({ app }) => app.video.currentTime > 0 && app.pageReplay.session?.kind === 'file');
    await blocked.close();

    if (process.env.STATIC_ONLY === '1') continue;
    const docker = await browser.newContext({ serviceWorkers: 'block' });
    const dockerPage = await docker.newPage();
    await dockerPage.route(base + '/', async route => {
      const response = await route.fetch();
      await route.fulfill({ response, body: (await response.text()).replace(
        'name="layerglass-backend" content="python"', 'name="layerglass-backend" content="choose"') });
    });
    await dockerPage.goto(base);
    await dockerPage.locator('[data-backend-choice="docker"]').click();
    await dockerPage.locator('#backend-connect-url').fill(base);
    await dockerPage.locator('.backend-connect-form [type="submit"]').click();
    await dockerPage.locator('#backend-picker').waitFor({ state: 'detached' });
    await waitForPlayer(dockerPage, ({ app }) => app.videoStream?.connected && app.video.currentTime > 0, null, { timeout: 45000 });
    assert.deepEqual(await dockerPage.evaluate(() => JSON.parse(localStorage.getItem('layerglass-backend'))), { type: 'python', url: base });
    await docker.close();
    const normal = await browser.newContext({ serviceWorkers: 'block' });
    await normal.addCookies([{ name: 'fixture-proxy-session', value: 'present', url: base, httpOnly: true }]);
    const normalPage = await normal.newPage();
    const headers = [];
    normalPage.on('request', request => {
      if (new URL(request.url()).pathname.startsWith('/api/')) headers.push(request.allHeaders());
    });
    await normalPage.goto(base);
    await waitForPlayer(normalPage, ({ app }) => app.videoStream?.connected && app.pageReplay.session?.kind === 'hls' && app.video.currentTime > 0,
      null, { timeout: 45000 });
    assert.equal(await normalPage.evaluate(async () => (await import('/static/backend/index.js')).backend.id), 'python');
    assert((await Promise.all(headers)).some(value => value.cookie?.includes('fixture-proxy-session=present')),
      'Same-origin backend requests preserve a reverse-proxy session cookie.');
    await normalPage.locator('#options-button').click();
    await normalPage.locator('[data-settings-target="connection"]').click();
    await normalPage.locator('#backend-type').selectOption('demo');
    await Promise.all([
      normalPage.waitForEvent('domcontentloaded'),
      normalPage.locator('#backend-form [type="submit"]').click(),
    ]);
    await waitForPlayer(normalPage, ({ app }) => app.pageReplay.session?.kind === 'file' && app.video.currentTime > 1);
    assert.equal(await normalPage.evaluate(async () => (await import('/static/backend/index.js')).backend.id), 'demo');
    await normal.close();
    console.log(`${name}: Python remains the self-hosted default; Connection switches to the browser provider`);
  } finally { await browser.close(); }
}
