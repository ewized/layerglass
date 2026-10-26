import { waitForPlayer } from './player-page.js';
import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';

const base = process.env.VIEWER_URL || 'http://127.0.0.1:8080';
const fixture = process.env.FIXTURE_URL || 'http://127.0.0.1:8080';
const first = { id: '1111111111111111', host: '192.168.50.2', port: 322, kind: 'rtsps', name: 'Workshop X2D', model_name: 'Bambu Lab X2D', serial: '20P000000000001', configured: true, discovered: true, setup: { type: 'access_code' } };
const second = { ...first, id: '2222222222222222', host: '192.168.50.3', name: 'Studio X1', model_name: 'Bambu Lab X1', serial: '00M000000000002', configured: false };

async function layoutAndDiscovery(browser) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  // Discovery fixtures also cover browsers/proxies without EventSource. Actual
  // SSE delivery and reconnection are exercised against the real video fixture.
  await page.addInitScript(() => { window.EventSource = undefined; });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let cameras = [];
  let statusState = 'empty';
  let configuredId = null;
  let calls = [];
  let failNextConfigure = false;
  let failNextForget = false;
  let rediscoverCameras = null;
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    calls.push({ path: url.pathname, camera: url.searchParams.get('camera') });
    let body;
    const catalog = () => ({ cameras, discovery: { state: 'done', checked: 1016, total: 1016, networks: ['192.168.50.0/24'] }, default_camera_id: cameras[0]?.id || null });
    const status = () => {
      const key = url.searchParams.get('camera') || cameras[0]?.id;
      const camera = cameras.find(item => item.id === key);
      return { state: !camera ? 'empty' : !camera.configured ? 'setup' : statusState, message: 'Fixture camera.', camera_id: key,
        generation: 'a'.repeat(32), playlist_url: null, jpeg_url: camera && statusState === 'live' ? `/api/cameras/${key}/frame.jpg` : null };
    };
    if (url.pathname === '/api/snapshot') {
      body = { version: 1, catalog: catalog(), status: status(), session_id: url.searchParams.get('session'), replay: null };
    } else if (url.pathname === '/api/cameras') {
      body = { cameras, discovery: { state: 'done', checked: 1016, total: 1016, networks: ['192.168.50.0/24'] }, default_camera_id: cameras[0]?.id || null };
    } else if (url.pathname === '/api/status') {
      body = status();
    } else if (url.pathname.endsWith('/configure')) {
      assert.equal(await request.headerValue('x-viewer-request'), '1');
      assert.equal(request.postDataJSON().access_code, 'test-access-code');
      if (failNextConfigure) {
        failNextConfigure = false;
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Try again.' }) });
        return;
      }
      configuredId = url.pathname.split('/')[3];
      cameras = cameras.map(camera => camera.id === configuredId ? { ...camera, configured: true } : camera);
      body = { ok: true };
    } else if (url.pathname.endsWith('/forget')) {
      assert.equal(await request.headerValue('x-viewer-request'), '1');
      if (failNextForget) {
        failNextForget = false;
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Try again.' }) });
        return;
      }
      const forgottenId = url.pathname.split('/')[3];
      cameras = cameras.filter(camera => camera.id !== forgottenId);
      body = { ok: true };
    } else if (url.pathname.endsWith('/frame.jpg')) {
      await route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#25362a"/></svg>' });
      return;
    } else {
      assert.equal(await request.headerValue('x-viewer-request'), '1');
      if (url.pathname === '/api/discover' && rediscoverCameras) {
        cameras = rediscoverCameras;
        rediscoverCameras = null;
      }
      body = { ok: true, queued: true };
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });

  await page.goto(base);
  await page.waitForFunction(() => document.querySelector('#overlay-title').textContent === 'No printer streams found');
  assert.equal(await page.locator('#camera-list [data-camera-id]').count(), 0);
  assert.equal(await page.locator('#loader').isVisible(), false);
  assert.equal(await page.locator('#refresh-button').isDisabled(), false);
  await page.getByRole('button', { name: 'Scan for printers', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('#scan-button').disabled);
  assert(calls.some(call => call.path === '/api/discover'));

  cameras = [first];
  statusState = 'connecting';
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#camera-name').textContent === 'Bambu Lab X2D');
  assert.equal(await page.locator('#player-options').isVisible(), false);
  const margins = await page.locator('#viewer').boundingBox();
  assert.equal(margins.x, 0);
  assert.equal(margins.width, 390, 'The video should fill the phone width.');
  assert(Math.abs(margins.height - 844) < 1, 'The player should fill the viewport.');

  cameras = [first, second];
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('#printers-button').click();
  await page.locator('#camera-list').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#camera-list [data-camera-id]').count(), 2);
  const secondRow = page.locator(`[data-camera-id="${second.id}"]`);
  assert.equal(await page.locator('.printer-code-form input:visible').count(), 0);
  assert.equal(await secondRow.locator('.printer-select').isDisabled(), true);
  await secondRow.locator('.printer-access').click();
  assert.equal(await page.locator('#camera-name').textContent(), first.model_name);
  await secondRow.locator('input').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#settings-title').textContent(), 'Printers');
  await secondRow.locator('input').fill('test-access-code');
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    const boxes = await secondRow.evaluate(row => {
      const input = row.querySelector('input').getBoundingClientRect();
      const save = row.querySelector('.printer-code-save').getBoundingClientRect();
      const forget = row.querySelector('.printer-forget').getBoundingClientRect();
      return { input: input.toJSON(), save: save.toJSON(), forget: forget.toJSON(), overflow: document.documentElement.scrollWidth > innerWidth };
    });
    assert.equal(boxes.overflow, false, 'The inline access-code row must fit on a phone.');
    assert(boxes.input.width >= 50 && boxes.save.height >= 44 && boxes.forget.height >= 44);
    assert(boxes.input.right <= boxes.save.left && boxes.save.right <= boxes.forget.left, 'Save must sit to the right of the input, before Forget.');
    if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/inline-code-${browser.browserType().name()}-${width}.png` });
  }
  failNextConfigure = true;
  await secondRow.locator('.printer-code-save').click();
  await secondRow.locator('.printer-error').waitFor({ state: 'visible' });
  assert.equal(await secondRow.locator('input').inputValue(), 'test-access-code');
  assert.equal(await page.locator('#settings-title').textContent(), 'Printers');
  assert.equal(await page.evaluate(() => localStorage.getItem('printer-camera')), first.id);
  await secondRow.locator('.printer-code-save').click();
  await page.locator('#player-options').waitFor({ state: 'hidden' });
  assert.equal(configuredId, second.id);
  assert.equal(await page.evaluate(() => localStorage.getItem('printer-camera')), second.id);
  await page.locator('#options-button').click();
  await page.locator('#printers-button').click();
  const firstRow = page.locator(`[data-camera-id="${first.id}"]`);
  assert.equal(await firstRow.locator('.printer-access').isVisible(), false);
  assert.equal(await secondRow.locator('.printer-access').isVisible(), false, 'A saved printer must hide its Access code button.');
  failNextForget = true;
  await firstRow.locator('.printer-forget').click();
  await firstRow.locator('.printer-error').waitFor({ state: 'visible' });
  assert.equal(await firstRow.locator('.printer-access').isVisible(), false);
  assert.equal(await page.evaluate(() => localStorage.getItem('printer-camera')), second.id);
  await firstRow.locator('.printer-forget').click();
  await page.locator(`[data-camera-id="${first.id}"]`).waitFor({ state: 'detached' });
  assert.equal(await page.locator('#settings-title').textContent(), 'Printers');
  assert.equal(await page.evaluate(() => localStorage.getItem('printer-camera')), second.id);
  await page.reload();
  await page.waitForFunction(key => document.querySelector(`[data-camera-id="${key}"] .printer-select`)?.getAttribute('aria-pressed') === 'true', second.id);
  calls = [];
  await page.locator('#options-button').click();
  await page.getByRole('button', { name: 'Refresh viewer', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#refresh-button').getAttribute('aria-busy') === 'true');
  assert(calls.some(call => call.path === '/api/restart' && call.camera === second.id));

  statusState = 'live';
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#overlay').hidden && !document.querySelector('#jpeg').hidden);
  assert.equal(await page.locator('#video').isVisible(), false);
  await page.locator('#options-button').click();
  for (const size of [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 844, height: 390 }, { width: 1280, height: 960 }]) {
    await page.evaluate(async () => {
      const { playerFullscreen } = await import('/static/player.js');
      return (playerFullscreen.exit());
    });
    await waitForPlayer(page, ({ app }) => {
      const { playerFullscreen } = app;
      return (!playerFullscreen.active() && !playerFullscreen.entering);
    });
    await page.setViewportSize(size);
    await waitForPlayer(page, ({ app }) => {
      const { playerFullscreen } = app;
      return (!playerFullscreen.entering);
    });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Layout overflows at ${size.width}px.`);
    const buttons = await page.locator('#player-toolbar button').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height));
    assert(buttons.every(height => height >= 44), 'Controls need 44px touch targets.');
  }
  if (!(await page.locator('#player-options').isVisible())) await page.locator('#options-button').click();
  await page.locator('#printers-button').click();
  await secondRow.locator('.printer-forget').click();
  await page.waitForFunction(() => document.querySelector('#overlay-title').textContent === 'No printer streams found');
  assert.equal(await page.locator('#camera-list [data-camera-id]').count(), 0);
  assert.equal(await page.evaluate(() => localStorage.getItem('printer-camera')), null);
  rediscoverCameras = [{ ...second, configured: false }];
  await page.locator('#scan-button').click();
  await secondRow.waitFor({ state: 'visible' });
  assert.equal(await secondRow.locator('.printer-access').isVisible(), true);
  assert.equal(await secondRow.locator('input').isVisible(), false, 'Rediscovery must not open access-code entry automatically.');
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#overlay-title').textContent === 'Connect this printer');
  assert.equal(await page.locator('#player-options').isVisible(), false, 'An unconfigured printer must not open settings on load.');
  await page.locator('#options-button').click();
  assert.equal(await page.locator('#settings-title').textContent(), 'Settings', 'Settings must open at the root menu.');
  await page.locator('#printers-button').click();
  assert.equal(await secondRow.locator('input').isVisible(), false);
  await secondRow.locator('.printer-access').click();
  assert.equal(await secondRow.locator('input').inputValue(), '', 'A rediscovered printer needs a fresh code.');
  await secondRow.locator('input').fill('unsaved-draft');
  await page.locator('#settings-back').click();
  await page.locator('#printers-button').click();
  assert.equal(await secondRow.locator('input').isVisible(), false, 'Returning to the list must not reopen the editor.');
  await secondRow.locator('.printer-access').click();
  assert.equal(await secondRow.locator('input').inputValue(), '', 'Leaving the list discards an unsaved draft.');
  assert.deepEqual(errors, [], 'Browser JavaScript errors.');
  await page.close();
}

async function realPlayback(browser) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(fixture);
  await page.waitForFunction(() => {
    const video = document.querySelector('video');
    return video.videoWidth > 0 && video.getVideoPlaybackQuality().totalVideoFrames > 5 && document.querySelector('#overlay').hidden;
  }, undefined, { timeout: 45000 });
  await page.locator('#options-button').click();
  await page.getByRole('button', { name: 'Refresh viewer', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#overlay').hidden, undefined, { timeout: 20000 });
  const previous = await page.evaluate(async () => (await (await fetch('/api/status')).json()).generation);
  await page.locator('#options-button').click();
  await page.getByRole('button', { name: 'Refresh viewer', exact: true }).click();
  const deadline = Date.now() + 30000;
  let restarted = false;
  while (Date.now() < deadline) {
    const current = await (await page.request.get(`${fixture}/api/status`)).json();
    if (current.state === 'live' && current.generation !== previous) { restarted = true; break; }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert(restarted, 'The relay must produce a new live generation.');
  await page.waitForFunction(() => document.querySelector('#overlay').hidden &&
    document.querySelector('#refresh-label').textContent === 'Refresh viewer' && document.querySelector('video').videoWidth > 0,
  undefined, { timeout: 30000 });
  assert.deepEqual(errors, []);
  if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/mobile-playback.png`, fullPage: true });
  await page.close();
}

(async () => {
  for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await engine.launch({ headless: true, args: name === 'chromium' ? ['--no-sandbox'] : [] });
    try {
      await layoutAndDiscovery(browser);
      if (name === 'chromium') await realPlayback(browser);
      console.log(`${name}: mobile layout, zero/one/multiple printers, scan, access-code setup, selection persistence, JPEG playback passed${name === 'chromium' ? '; real HLS playback, refresh, restart passed' : ''}`);
    } finally { await browser.close(); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
