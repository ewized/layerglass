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
    // Match static hosts that ignore byte ranges. The demo must still open its
    // preloaded position and seek natively after one complete clip download.
    await page.route(base + '/static/demo/printer.mp4', async route => {
      const headers = { ...route.request().headers() };
      delete headers.range;
      const response = await route.fetch({ headers });
      await route.fulfill({ status: 200, headers: { 'Content-Type': 'video/mp4' }, body: await response.body() });
    });
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
    assert(await page.locator('video').evaluate(video => video.currentSrc.startsWith('blob:')),
      'The bundled clip must be natively seekable even when its host ignores Range requests.');
    await waitForPlayer(page, ({ app }) => app.video.currentTime >= 179 && app.pageReplay.session.end_seconds >= 180 &&
      document.querySelector('#timeline-events').groups?.flatMap(group => group.events).length === 3);
    assert(await page.locator('video').evaluate(video => video.currentTime < 195), 'The demo opens at its preloaded live edge.');
    const demoEvents = await page.locator('#timeline-events').evaluate(markers => markers.groups.flatMap(group =>
      group.events.map(({ type, position }) => [type, position])));
    assert.deepEqual(demoEvents, [['started', 2], ['paused', 30], ['resumed', 35]],
      'Preloaded events appear immediately without seeking or waiting for a real print.');
    const pausedGroup = await page.locator('#timeline-events').evaluate(markers => {
      const index = markers.groups.findIndex(group => group.events.some(event => event.type === 'paused'));
      return { index, clustered: markers.groups[index].events.length > 1 };
    });
    await page.locator('.timeline-event').nth(pausedGroup.index).tap();
    if (pausedGroup.clustered) await page.getByRole('menuitem', { name: /^Print paused/ }).tap();
    await waitForPlayer(page, ({ app }) => app.video.currentTime >= 30 && app.video.currentTime < 35 && !app.video.seeking);
    await page.evaluate(async () => {
      const app = await import('/static/player.js');
      app.pageReplay.togglePause();
      app.playerTools.showStats(true);
    });
    await page.waitForFunction(() => document.querySelector('[data-stat-key="print_state"]')?.textContent === 'PAUSE');
    assert.equal(await page.locator('#live-button').getAttribute('aria-pressed'), 'false');
    assert.match(await page.locator('#replay-time').textContent(), /^−[23]:\d{2}$/);
    await page.screenshot({ path: `/app/test-results/demo-preloaded-replay-${name}.png` });
    await page.evaluate(async () => {
      const app = await import('/static/player.js');
      app.playerTools.showStats(false);
      app.pageReplay.goLive();
    });
    await waitForPlayer(page, ({ app }) => app.pageReplay.followLive && app.video.currentTime >= 179 && !app.video.paused);
    assert.equal(await page.locator('#camera-name').textContent(), 'Demo printer');
    assert.equal(await page.locator('#cast-button').isDisabled(), true);
    await page.locator('#options-button').click();
    assert.equal(await page.locator('#printers-button').isVisible(), false);
    assert.equal(await page.locator('[data-settings-page="root"] #refresh-button').isVisible(), true);
    assert.equal(await page.locator('#restart-button').count(), 0);
    const demoSession = await page.evaluate(async () => {
      const app = await import('/static/player.js');
      window.settingsVideo = app.video;
      return app.pageReplay.session.session_id;
    });
    const demoDownloads = requests.filter(path => path.endsWith('/demo/printer.mp4')).length;
    await page.locator('#refresh-button').click();
    await page.locator('#player-options').waitFor({ state: 'hidden' });
    await waitForPlayer(page, ({ app }) => app.video.readyState >= 2 && !app.video.paused);
    assert.equal(await page.evaluate(async () => (await import('/static/player.js')).pageReplay.session.session_id), demoSession);
    assert.equal(await page.evaluate(() => document.querySelector('video') === window.settingsVideo), true);
    assert.equal(requests.filter(path => path.endsWith('/demo/printer.mp4')).length, demoDownloads,
      'Refresh must reuse the prepared demo clip instead of downloading it again.');
    await page.locator('#options-button').click();
    await page.locator('[data-settings-target="backends"]').click();
    assert.equal(await page.locator('#settings-title').textContent(), 'Backend');
    assert.equal(await page.locator('#backend-list select').count(), 0);
    assert.equal(await page.locator('[data-backend-select="demo"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('[data-backend-select="demo"] .printer-state').isVisible(), true);
    assert.equal(await page.locator('#backend-form').isVisible(), false, 'Backend selection must not force an address editor open.');
    assert.equal(await page.locator('#refresh-button').isVisible(), false);
    await page.screenshot({ path: `/app/test-results/backend-list-${name}.png` });
    // Match the printer access-code interaction: editing does not connect;
    // one adjacent icon confirms, with errors below the whole input row.
    await page.locator('[data-backend-select="python"]').click();
    await page.locator('#backend-url').fill(base);
    await page.evaluate(() => {
      window.backendTestFetch = window.fetch;
      window.backendTestRequests = 0;
      window.fetch = (input, options) => {
        if (new URL(input, location.href).pathname === '/api/backend') {
          window.backendTestRequests++;
          return new Promise((_resolve, reject) => { window.backendTestReject = reject; });
        }
        return window.backendTestFetch(input, options);
      };
    });
    await page.locator('#backend-url').fill(base + '/');
    assert.equal(await page.evaluate(() => window.backendTestRequests), 0);
    await page.getByRole('button', { name: 'Save and connect', exact: true }).click();
    assert.equal(await page.locator('#backend-confirm').isDisabled(), true);
    assert.equal(await page.locator('#backend-url').isDisabled(), true);
    assert.equal(await page.locator('#backend-list [data-backend-select]').evaluateAll(buttons => buttons.every(button => button.disabled)), true);
    assert.equal(await page.locator('#backend-confirm').getAttribute('aria-busy'), 'true');
    await page.evaluate(() => document.querySelector('#backend-form').requestSubmit());
    assert.equal(await page.evaluate(() => window.backendTestRequests), 1, 'Pending confirmation must not submit twice.');
    await page.evaluate(() => window.backendTestReject(new DOMException('signal timed out', 'TimeoutError')));
    await page.waitForFunction(() => document.querySelector('#backend-error').textContent.startsWith('Connection timed out.'));
    assert.equal(await page.locator('#backend-url').getAttribute('aria-invalid'), 'true');
    assert.equal(await page.locator('#backend-confirm').isDisabled(), false);
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('layerglass-backend'))), { type: 'demo' });
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      const layout = await page.evaluate(() => {
        const box = id => { const r = document.getElementById(id).getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, height: r.height }; };
        return { input: box('backend-url'), button: box('backend-confirm'), error: box('backend-error'), note: box('backend-capabilities'),
          overflow: document.documentElement.scrollWidth > innerWidth };
      });
      assert.equal(layout.overflow, false);
      assert(Math.abs(layout.input.y - layout.button.y) < 1);
      assert(layout.input.height <= 48 && layout.button.height === 44);
      assert(layout.button.x >= layout.input.right);
      assert(layout.error.y >= layout.input.bottom);
      assert(layout.error.x <= layout.input.x && layout.error.right >= layout.button.right - 1);
      assert(layout.note.y >= layout.error.bottom);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `/app/test-results/backend-confirm-${name}.png` });
    await page.locator('#backend-url').fill(base);
    assert.equal(await page.locator('#backend-error').isVisible(), false, 'Editing clears the error for the previous address.');
    assert.equal(await page.locator('#backend-url').getAttribute('aria-invalid'), null);
    await page.evaluate(() => { window.fetch = window.backendTestFetch; });
    await page.locator('#backend-url').fill('not a backend address');
    await page.locator('[data-backend-select="demo"]').click();
    assert.equal(await page.locator('#backend-form').isVisible(), false);
    assert.equal(await page.locator('#backend-url').isDisabled(), true);
    assert.equal(await page.locator('#backend-form').evaluate(form => form.checkValidity()), true,
      'A hidden invalid address draft must not prevent selecting Demo.');
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
    assert(await page.locator('#replay-slider').evaluate(slider => Number(slider.max) < 10), 'Local files must not inherit the demo prebuffer.');
    assert.equal(await page.locator('.timeline-event').count(), 0, 'Local files must not retain demo print events.');
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
    assert.equal(await normalPage.locator('#selected-backend').textContent(), 'Docker backend');
    const beforeRefresh = await normalPage.evaluate(async () => {
      const app = await import('/static/player.js');
      window.settingsVideo = app.video;
      return { session: app.pageReplay.session.session_id, generation: app.status.generation };
    });
    let restartCalls = 0;
    let releaseRestart;
    let sawFailedRestart;
    const interceptedRestart = new Promise(resolve => { sawFailedRestart = resolve; });
    const failedRestart = route => {
      restartCalls++;
      releaseRestart = () => route.fulfill({ status: 503, json: { error: 'Fixture restart unavailable' } });
      sawFailedRestart();
    };
    await normalPage.route('**/api/restart?*', failedRestart);
    await normalPage.locator('#refresh-button').click();
    await interceptedRestart;
    assert.equal(await normalPage.locator('#refresh-button').getAttribute('aria-busy'), 'true');
    assert.equal(await normalPage.locator('#refresh-button').isDisabled(), true);
    await normalPage.locator('#refresh-button').dispatchEvent('click');
    assert.equal(restartCalls, 1, 'A pending refresh must not restart the camera twice.');
    await releaseRestart();
    await normalPage.waitForFunction(() => !document.querySelector('#refresh-button').disabled);
    assert.equal(await normalPage.locator('#refresh-button').getAttribute('aria-busy'), 'false');
    assert.equal(await normalPage.evaluate(async () => (await import('/static/player.js')).pageReplay.session.session_id), beforeRefresh.session);
    await normalPage.unroute('**/api/restart?*', failedRestart);
    const restarted = normalPage.waitForResponse(response => new URL(response.url()).pathname === '/api/restart');
    await normalPage.locator('#refresh-button').click();
    assert.equal((await restarted).status(), 202);
    await waitForPlayer(normalPage, ({ app }, generation) => app.status.generation !== generation &&
      app.status.state === 'live' && app.video.readyState >= 2 && !app.video.paused &&
      document.querySelector('#refresh-button').getAttribute('aria-busy') === 'false', beforeRefresh.generation, { timeout: 45000 });
    assert.equal(await normalPage.evaluate(() => document.querySelector('video') === window.settingsVideo), true);
    assert.equal(await normalPage.evaluate(async () => (await import('/static/player.js')).pageReplay.session.session_id), beforeRefresh.session,
      'The combined refresh restarts the camera without opening a new page recording.');
    await normalPage.locator('#options-button').click();
    await normalPage.locator('[data-settings-target="backends"]').click();
    assert.equal(await normalPage.locator('[data-backend-select="python"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await normalPage.locator('[data-backend-select="python"] .printer-state').isVisible(), true);
    assert.equal(await normalPage.locator('#backend-form').isVisible(), false);
    await normalPage.locator('[data-backend-edit="python"]').click();
    await normalPage.locator('#backend-url').fill('not a backend address');
    await Promise.all([
      normalPage.waitForEvent('domcontentloaded'),
      normalPage.locator('[data-backend-select="demo"]').click(),
    ]);
    await waitForPlayer(normalPage, ({ app }) => app.pageReplay.session?.kind === 'file' && app.video.currentTime > 1);
    assert.equal(await normalPage.evaluate(async () => (await import('/static/backend/index.js')).backend.id), 'demo');
    await normal.close();
    console.log(`${name}: root refresh restarts once, recovers from failure and retains recording; Backend list switches to Demo`);
  } finally { await browser.close(); }
}
