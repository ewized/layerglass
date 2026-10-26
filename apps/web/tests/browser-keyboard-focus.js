import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { waitForPlayer } from './player-page.js';

const base = process.env.VIEWER_URL || 'http://127.0.0.1:8080';
const origin = new URL(base).origin;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(predicate, message) {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    assert(Date.now() < deadline, message);
    await pause(20);
  }
}

async function focused(locator, message) {
  assert.equal(await locator.evaluate(node => node.ownerDocument.activeElement === node), true, message);
}

async function settle(route, json, status = 200, cancelled = false) {
  try { await route.fulfill({ status, json }); }
  catch (error) { if (!cancelled) throw error; }
}

async function menuAndStats(browser) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.keyboardPip = false;
    window.keyboardPipCalls = 0;
    Object.defineProperty(document, 'pictureInPictureEnabled', { get: () => window.keyboardPip, configurable: true });
    HTMLVideoElement.prototype.requestPictureInPicture = async () => { window.keyboardPipCalls++; };
    HTMLVideoElement.prototype.webkitSupportsPresentationMode = () => false;
  });
  try {
    await page.goto(base);
    await page.waitForFunction(() => document.querySelector('video')?.videoWidth > 0 &&
      !document.querySelector('video').paused && document.querySelector('#overlay').hidden, undefined, { timeout: 45000 });
    await page.evaluate(async () => {
      const app = await import('/static/player.js');
      window.keyboardVideo = app.video;
      window.keyboardSession = app.pageReplay.session.session_id;
    });
    const player = page.locator('#player');
    const menu = page.locator('#video-context-menu');
    const mini = menu.locator('[data-player-action="mini"]');
    const stats = menu.locator('[data-player-action="stats"]');
    const copy = menu.locator('[data-player-action="copy-debug"]');
    const open = async () => { await player.focus(); await page.keyboard.press('Shift+F10'); await menu.waitFor({ state: 'visible' }); };
    const close = async () => { await page.keyboard.press('Escape'); await menu.waitFor({ state: 'hidden' }); await focused(player); };

    await open();
    assert.equal(await mini.isDisabled(), true);
    await focused(stats, 'Unavailable Mini must not prevent initial menu focus.');
    await page.keyboard.press('ArrowUp'); await focused(copy);
    await page.keyboard.press('ArrowDown'); await focused(stats);
    await page.keyboard.press('End'); await focused(copy);
    await page.keyboard.press('Home'); await focused(stats);
    await close();

    await page.evaluate(() => { window.keyboardPip = true; document.querySelector('#player').classList.add('live-only'); });
    await open();
    assert.equal(await mini.isVisible(), false);
    assert.equal(await mini.isDisabled(), false, 'This case excludes Mini because it is hidden, not disabled.');
    await focused(stats);
    await page.keyboard.press('ArrowUp'); await focused(copy);
    await page.keyboard.press('Home'); await focused(stats);
    await close();

    await page.evaluate(() => document.querySelector('#player').classList.remove('live-only'));
    await open(); await focused(mini);
    await page.keyboard.press('ArrowUp'); await focused(copy);
    await page.keyboard.press('ArrowDown'); await focused(mini);
    await page.keyboard.press('ArrowDown'); await focused(stats);
    await page.keyboard.press('Home'); await focused(mini);
    await page.keyboard.press('End'); await focused(copy);
    await close();

    await page.evaluate(() => {
      document.querySelector('#player').classList.add('live-only');
      for (const button of document.querySelectorAll('#video-context-menu button:not([data-player-action="mini"])')) button.disabled = true;
    });
    await open(); await focused(player, 'A menu with no available actions must leave focus safe.');
    await menu.evaluate(node => { node.tabIndex = -1; node.focus(); });
    for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End']) { await page.keyboard.press(key); await focused(menu); }
    await close();
    await page.evaluate(() => {
      window.keyboardPip = false;
      document.querySelector('#player').classList.remove('live-only');
      for (const button of document.querySelectorAll('#video-context-menu button')) button.disabled = false;
    });

    await open(); await focused(stats);
    await page.keyboard.press('Enter');
    const closeStats = page.locator('#close-stats');
    await focused(closeStats, 'Keyboard Stats activation must hand focus to the opened panel.');
    assert.equal(await page.locator('#player-stats').evaluate(node => node.timer !== null), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#player-stats').isVisible(), false);
    await focused(player);
    assert.equal(await page.locator('#player-stats').evaluate(node => node.timer), null);
    await open(); await page.keyboard.press('Enter'); await focused(closeStats);
    await page.keyboard.press('Enter'); await focused(player);
    assert.equal(await page.locator('#player-stats').isVisible(), false);

    await page.locator('video').click({ button: 'right' });
    await stats.click();
    assert.equal(await closeStats.evaluate(node => node.ownerDocument.activeElement === node), false,
      'Pointer Stats activation must not force focus into the panel.');
    await page.locator('#options-button').click();
    await focused(page.locator('#printers-button'));
    await page.locator('#player-stats').evaluate(node => node.show(false));
    await focused(page.locator('#printers-button'), 'Hiding Stats must not steal unrelated settings focus.');
    await page.keyboard.press('Escape');
    await waitForPlayer(page, ({ app }) => app.video === window.keyboardVideo &&
      app.pageReplay.session.session_id === window.keyboardSession && !app.video.paused && app.video.readyState >= 2);
    assert.equal(await page.locator('video').count(), 1);
    assert.equal(await page.evaluate(() => window.keyboardPipCalls), 0);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
}

async function onboarding(browser, name) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const checks = [];
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/keyboard-picker-fixture', route => route.fulfill({ contentType: 'text/html', body: `
    <!doctype html><html><head><link rel="stylesheet" href="/static/style.css"></head><body>
    <printer-backend-picker id="backend-picker"></printer-backend-picker><script type="module">
    import { PrinterBackendPicker } from '/static/components/backend-picker.js';
    customElements.define('printer-backend-picker', PrinterBackendPicker);
    window.selections = [];
    document.querySelector('#backend-picker').addEventListener('backend-select', event => window.selections.push(event.detail));
    </script></body></html>` }));
  await page.route('**/api/backend', route => { checks.push(route); });
  const directChecks = [];
  await page.route('**/server/info', route => { directChecks.push(route); });
  await page.route('**/printer/info', route => settle(route, { result: { state: 'ready', hostname: 'Generated controller', software_version: 'v0.13.0' } }));
  await page.route('**/server/webcams/list', route => settle(route, { result: { webcams: [
    { uid: 'fixture', name: 'Generated camera', enabled: true, service: 'mjpegstreamer', stream_url: '/webcam/?action=stream' },
  ] } }));
  try {
    await page.goto(origin + '/keyboard-picker-fixture');
    const input = page.locator('#backend-connect-url');
    const back = page.locator('[data-backend-back]');
    const choose = async type => { await page.locator(`[data-backend-choice="${type}"]`).focus(); await page.keyboard.press('Enter'); await focused(input); };
    const submit = async count => {
      await input.fill(origin); await page.keyboard.press('Enter');
      await until(() => checks.length === count, 'Docker check did not start.');
      assert.equal(await input.isDisabled(), true);
      await focused(back, 'Pending input lock must keep Escape and Back in keyboard reach.');
      assert.equal(await back.isDisabled(), false);
    };
    const noSelection = async () => {
      assert.deepEqual(await page.evaluate(() => window.selections), []);
      assert.equal(await page.evaluate(() => localStorage.getItem('layerglass-backend')), null);
    };
    await choose('docker'); await submit(1);
    await page.keyboard.type('different.fixture.test');
    assert.equal(await input.inputValue(), origin, 'The displayed address must stay bound to the checked origin.');
    await page.keyboard.press('Escape');
    await focused(page.locator('[data-backend-choice="docker"]'));
    assert.equal(await input.isDisabled(), false);
    await settle(checks[0], { id: 'python', protocol_version: 1 }, 200, true);
    await noSelection();

    await choose('docker'); await submit(2);
    await page.keyboard.press('Enter'); // The reachable Back button cancels.
    await focused(page.locator('[data-backend-choice="docker"]'));
    await settle(checks[1], { id: 'python', protocol_version: 1 }, 200, true);
    await noSelection();

    await choose('docker'); await submit(3);
    await settle(checks[2], { id: 'unrelated', protocol_version: 1 });
    await page.locator('.backend-connect-error').waitFor({ state: 'visible' });
    assert.equal(await input.isDisabled(), false); await focused(input);
    await noSelection();
    await submit(4);
    await page.waitForFunction(() => document.querySelector('.backend-connect-error').textContent.includes('timed out'), undefined, { timeout: 10000 });
    assert.equal(await input.isDisabled(), false); await focused(input);
    await settle(checks[3], { id: 'python', protocol_version: 1 }, 200, true);
    await noSelection();

    await submit(5);
    await settle(checks[4], { id: 'python', protocol_version: 1 });
    await page.waitForFunction(() => window.selections.length === 1);
    assert.equal(await input.inputValue(), origin);
    assert.deepEqual(await page.evaluate(() => window.selections), [{ type: 'python', url: origin }]);
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('layerglass-backend'))), { type: 'python', url: origin });

    if (name === 'webkit') {
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('[data-backend-choice="direct"]').isDisabled(), true);
    } else {
      await page.evaluate(() => { window.selections = []; localStorage.removeItem('layerglass-backend'); });
      await page.keyboard.press('Escape'); await choose('direct');
      await input.fill(origin); await page.keyboard.press('Enter');
      await until(() => directChecks.length === 1, 'Direct identity check did not start.');
      assert.equal(await input.isDisabled(), true); await focused(back);
      await page.keyboard.press('Escape');
      assert.equal(await input.isDisabled(), false);
      await settle(directChecks[0], { result: {} }, 200, true);
      await noSelection();
      await choose('direct'); await input.fill(origin); await page.keyboard.press('Enter');
      await until(() => directChecks.length === 2, 'Second Direct identity check did not start.');
      assert.equal(await input.isDisabled(), true); await focused(back);
      await settle(directChecks[1], { result: { moonraker_version: 'v0.9.3', api_version: [1, 5, 0], components: ['klippy_apis'], klippy_connected: true } });
      await page.waitForFunction(() => window.selections.length === 1);
      assert.deepEqual(await page.evaluate(() => window.selections[0]), { type: 'direct', profile: 'moonraker', url: origin });
      assert.equal(await input.inputValue(), origin);
    }
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
}

async function rejectedSetup(browser) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const requests = [];
  const errors = [];
  const camera = { id: '1111111111111111', host: '192.0.2.1', port: 322, name: 'Generated printer',
    model_name: 'Bambu Lab X2D', serial: '20P000000000001', configured: false, discovered: true, setup: { type: 'access_code' } };
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => { window.EventSource = undefined; });
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/configure')) { requests.push(route); return; }
    const catalog = { cameras: [camera], default_camera_id: camera.id,
      discovery: { state: 'done', checked: 1, total: 1, networks: ['192.0.2.0/24'] } };
    const status = { state: camera.configured ? 'connecting' : 'setup', camera_id: camera.id,
      generation: null, playlist_url: null, jpeg_url: null, message: 'Generated setup fixture.' };
    await settle(route, path === '/api/snapshot' ? { version: 1, catalog, status, session_id: null, replay: null } :
      path === '/api/cameras' ? catalog : path === '/api/status' ? status : { ok: true });
  });
  try {
    await page.goto(base);
    await page.waitForFunction(() => document.querySelector('#camera-list')?.children.length === 1);
    const input = page.locator('.printer-code-form input');
    const options = page.locator('#options-button');
    const editor = page.locator('.printer-code-form');
    const open = async () => {
      if (!await page.locator('#player-options').isVisible()) { await options.focus(); await page.keyboard.press('Enter'); }
      if (!await page.locator('[data-settings-page="printers"]').isVisible()) await page.locator('#printers-button').press('Enter');
      if (!await editor.isVisible()) await page.locator('.printer-access').press('Enter');
      await input.fill('generated-fixture-code');
    };
    const submit = async count => {
      await input.focus(); await page.keyboard.press('Enter');
      await until(() => requests.length === count, 'Configure request did not start.');
      assert.equal(await input.isDisabled(), true);
    };
    const reject = async count => {
      await settle(requests[count - 1], { error: 'Generated configure failure' }, 503);
      await page.waitForFunction(() => !document.querySelector('.printer-code-form input').disabled &&
        document.querySelector('.printer-error').textContent.includes('Could not save'));
    };
    await open(); await submit(1); await reject(1);
    assert.equal(await page.locator('.printer-error').isVisible(), true);
    await focused(input, 'Rejected keyboard setup must return to the same usable editor.');
    assert.equal(await input.inputValue(), 'generated-fixture-code');
    await page.keyboard.press('Enter'); await until(() => requests.length === 2, 'Enter did not retry exactly once.');
    await reject(2); await focused(input);
    assert.equal(requests.length, 2);

    await submit(3);
    await options.focus();
    await reject(3);
    await focused(options, 'Failure must not reclaim another visible control\'s focus.');

    await submit(4);
    await page.mouse.click(200, 100);
    const pointerFocus = await page.evaluateHandle(() => document.activeElement);
    await reject(4);
    assert.equal(await pointerFocus.evaluate(node => node === document.activeElement), true,
      'Failure must preserve the native pointer focus result, including body or WebKit\'s retained input.');
    await pointerFocus.dispose();

    await submit(5);
    const dismissedFocus = await page.locator('#camera-list').evaluateHandle(list => {
      list.closeEditor();
      return document.activeElement;
    });
    await reject(5);
    assert.equal(await editor.isVisible(), false);
    assert.equal(await dismissedFocus.evaluate(node => node === document.activeElement), true,
      'A response must not change the focus left by programmatic editor dismissal.');
    await dismissedFocus.dispose();

    await open(); await submit(6);
    await options.focus(); await page.keyboard.press('Enter');
    assert.equal(await page.locator('#player-options').isVisible(), false);
    await reject(6);
    assert.equal(await page.locator('#player-options').isVisible(), false);
    await focused(options);

    await open(); await submit(7);
    camera.configured = true;
    await settle(requests[6], { ok: true });
    await page.locator('#player-options').waitFor({ state: 'hidden' });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    assert.equal(await editor.evaluate(node => node.contains(document.activeElement)), false,
      'Successful setup must not restore focus into a hidden editor.');
    assert.equal(requests.length, 7);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
}

async function rejectedBackend(browser, name) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const checks = [];
  const directChecks = [];
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.backendFocusAttempts = [];
    const focus = HTMLElement.prototype.focus;
    HTMLElement.prototype.focus = function(...args) {
      if (this.id === 'backend-url') window.backendFocusAttempts.push({ connected: this.isConnected });
      return focus.apply(this, args);
    };
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key === 'layerglass-backend' && window.failBackendStorage) throw new DOMException('Generated storage failure', 'QuotaExceededError');
      return set.call(this, key, value);
    };
  });
  await page.route('**/api/backend', route => { checks.push(route); });
  await page.route('**/server/info', route => { directChecks.push(route); });
  try {
    const demo = new URL(base); demo.searchParams.set('backend', 'demo');
    await page.goto(demo.href);
    await page.waitForFunction(() => document.querySelector('#backend-list')?.current?.type === 'demo');
    const input = page.locator('#backend-url');
    const options = page.locator('#options-button');
    const open = async (type = 'python') => {
      if (!await page.locator('#player-options').isVisible()) { await options.focus(); await page.keyboard.press('Enter'); }
      if (!await page.locator('[data-settings-page="backends"]').isVisible()) await page.locator('#backends-button').press('Enter');
      await page.locator(`[data-backend-edit="${type}"]`).press('Enter');
      await input.fill(origin); await focused(input);
    };
    const submit = async (pending = checks) => {
      const prior = pending.length;
      await input.focus(); await page.keyboard.press('Enter');
      await until(() => pending.length === prior + 1, 'Backend check did not start once.');
      assert.equal(await input.isDisabled(), true);
      await page.evaluate(() => { window.backendFocusAttempts = []; });
      return pending[prior];
    };
    const failed = async (route, json = { error: 'Generated backend unavailable' }, status = 503) => {
      await settle(route, json, status);
      await page.waitForFunction(() => !document.querySelector('#backend-url').disabled &&
        !document.querySelector('#backend-error').hidden);
      assert.equal(await input.inputValue(), origin);
      assert.equal(await page.locator('#selected-backend').textContent(), 'Demo');
    };
    await open();
    await failed(await submit()); await focused(input, 'A rejected Settings check must restore its owned editor.');
    const retry = await submit();
    await page.keyboard.press('Enter');
    assert.equal(checks.length, 2, 'A busy retry must remain one bounded check.');
    await failed(retry, { id: 'unrelated', protocol_version: 1 }, 200); await focused(input);

    const timeout = await submit();
    await page.waitForFunction(() => document.querySelector('#backend-error').textContent.includes('timed out'), undefined, { timeout: 10000 });
    assert.equal(await input.isDisabled(), false); await focused(input);
    await settle(timeout, {}, 503, true);

    await page.evaluate(() => { window.failBackendStorage = true; });
    await failed(await submit(), { id: 'python', protocol_version: 1 }, 200);
    await focused(input); assert.match(await page.locator('#backend-error').textContent(), /Generated storage failure/);
    await page.evaluate(() => { window.failBackendStorage = false; });

    const beforeInvalid = checks.length;
    await input.fill('https://generated.invalid/path'); await page.keyboard.press('Enter');
    await page.locator('#backend-error').waitFor({ state: 'visible' });
    assert.equal(checks.length, beforeInvalid, 'An invalid origin must not start a check.');
    await focused(input); await input.fill(origin);

    const moved = await submit(); await options.focus(); await failed(moved); await focused(options);
    assert.deepEqual(await page.evaluate(() => window.backendFocusAttempts), []);

    const dismissed = await submit(); await options.focus(); await page.keyboard.press('Enter');
    await failed(dismissed);
    assert.equal(await page.locator('#player-options').isVisible(), false); await focused(options);
    assert.deepEqual(await page.evaluate(() => window.backendFocusAttempts), []);

    await open(); const navigated = await submit();
    await page.locator('#settings-back').press('Enter'); await failed(navigated);
    assert.equal(await page.locator('#player-options').evaluate(panel => panel.page), 'root');
    await focused(page.locator('#backends-button'));
    assert.deepEqual(await page.evaluate(() => window.backendFocusAttempts), []);

    await open(); const hidden = await submit();
    await page.locator('#player-options').evaluate(panel => { panel.hidden = true; });
    await page.waitForFunction(() => !document.querySelector('#backend-form').contains(document.activeElement));
    await failed(hidden);
    assert.deepEqual(await page.evaluate(() => window.backendFocusAttempts), [], 'A hidden editor must not receive even a focus attempt.');

    await open(); const disconnected = await submit();
    await page.locator('#backend-list').evaluate(list => {
      window.detachedBackendList = list;
      window.backendPlaceholder = document.createComment('backend fixture');
      list.before(window.backendPlaceholder); list.remove();
    });
    await page.waitForFunction(() => document.activeElement === document.body);
    await settle(disconnected, {}, 503);
    await page.waitForFunction(() => !window.detachedBackendList.busy);
    assert.deepEqual(await page.evaluate(() => window.backendFocusAttempts), [], 'A disconnected editor cannot regain focus.');
    await page.evaluate(() => window.backendPlaceholder.replaceWith(window.detachedBackendList));
    assert.equal(await input.inputValue(), origin);

    await open(); const replaced = await submit();
    await page.locator('#backend-list').evaluate(list => {
      window.originalBackendInput = list.input;
      const replacement = list.input.cloneNode(true); replacement.value = list.input.value;
      list.input.replaceWith(replacement); list.input = replacement;
    });
    await page.waitForFunction(() => document.activeElement === document.body);
    await failed(replaced);
    assert.deepEqual(await page.evaluate(() => window.backendFocusAttempts), [], 'A replacement field does not own the old request.');
    await page.locator('#backend-list').evaluate(list => { list.input.replaceWith(window.originalBackendInput); list.input = window.originalBackendInput; list.render(); });

    await open(); await options.focus();
    const unownedIndex = checks.length;
    await page.locator('#backend-form').evaluate(form => form.requestSubmit());
    await until(() => checks.length === unownedIndex + 1, 'Unowned fixture check did not start.');
    await page.evaluate(() => { window.backendFocusAttempts = []; });
    await failed(checks[unownedIndex]); await focused(options);
    assert.deepEqual(await page.evaluate(() => window.backendFocusAttempts), []);

    const directSupported = await page.locator('[data-backend-edit="direct"]').isEnabled();
    if (directSupported) {
      await open('direct'); await failed(await submit(directChecks)); await focused(input);
      assert.equal(directChecks.length, 1);
    }
    assert.equal(await page.evaluate(() => localStorage.getItem('layerglass-backend')), null);

    await open(); const success = await submit();
    await settle(success, { id: 'python', protocol_version: 1 });
    await page.waitForURL(url => !url.searchParams.has('backend'));
    await page.waitForFunction(() => document.querySelector('#backend-list')?.current?.type === 'python');
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('layerglass-backend'))), { type: 'python', url: origin });
    assert.equal(await page.locator('#backend-form').evaluate(form => form.hidden), true);
    assert.deepEqual(errors, []);
    console.log(`${name}: Settings backend rejection/retry, incompatible/invalid/timeout/storage errors, moved/hidden/disconnected/replaced ownership, ${directSupported ? 'supported Direct failure, ' : ''}and successful reload passed.`);
  } finally { await page.close(); }
}

async function copyFeedbackFocus(browser, name) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.copyMode = 'success';
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () =>
      window.copyMode === 'failure' ? Promise.reject(new DOMException('Generated rejection', 'NotAllowedError')) :
      window.copyMode === 'pending' ? new Promise(resolve => { window.finishCopy = resolve; }) : Promise.resolve() } });
    Object.defineProperty(document, 'pictureInPictureEnabled', { configurable: true, value: false });
    HTMLVideoElement.prototype.webkitSupportsPresentationMode = () => false;
  });
  try {
    await page.goto(base);
    await waitForPlayer(page, ({ app }) => app.video.readyState >= 2 && app.pageReplay.session?.ready &&
      app.pageReplay.session.end_seconds >= 4, undefined, { timeout: 45000 });
    await page.evaluate(async () => {
      const app = await import('/static/player.js');
      app.video.pause();
      const bounds = app.pageReplay.bounds(); app.pageReplay.seek((bounds.start + bounds.end) / 2);
      window.copyFocusOriginal = { video: app.video, decoder: app.hls, token: app.pageReplay.session.session_id };
      window.copyFocusCommits = 0;
      window.addEventListener('replaypositionchange', () => window.copyFocusCommits++);
    });
    await waitForPlayer(page, ({ app }) => app.video.paused && !app.video.seeking);
    const player = page.locator('#player');
    const menu = page.locator('#video-context-menu');
    const slider = page.locator('#replay-slider');
    const copy = menu.locator('[data-player-action="copy-debug"]');
    const open = async () => { await player.focus(); await page.keyboard.press('Shift+F10'); await page.keyboard.press('End'); await focused(copy); };
    const copied = async () => { await open(); await page.keyboard.press('Enter'); await page.waitForFunction(() => document.querySelector('[data-player-action="copy-debug"] span').textContent === 'Copied'); };
    const tabTo = async locator => {
      for (let count = 0; count < 12 && !await locator.evaluate(node => node === document.activeElement); count++) await page.keyboard.press('Tab');
      await focused(locator);
    };

    await copied(); await menu.waitFor({ state: 'hidden' }); await focused(player);
    await copied(); await tabTo(slider);
    await page.keyboard.down('ArrowRight');
    await waitForPlayer(page, ({ app }) => app.pageReplay.scrubType === 'keyboard' && app.pageReplay.previewChanged);
    const target = await slider.inputValue();
    await menu.waitFor({ state: 'hidden' });
    await focused(slider, 'Copy feedback must not interrupt the later keyboard scrub.');
    await waitForPlayer(page, ({ app }) => app.pageReplay.scrubType === 'keyboard');
    assert.equal(await page.evaluate(() => window.copyFocusCommits), 0);
    await page.keyboard.up('ArrowRight');
    assert.equal(await page.evaluate(() => window.copyFocusCommits), 1);
    await waitForPlayer(page, ({ app, arg: expected }) => !app.video.seeking && Math.abs(app.video.currentTime - expected) < 0.2,
      Number(target), { timeout: 15000 });

    await copied(); await tabTo(page.locator('#options-button'));
    await menu.waitFor({ state: 'hidden' }); await focused(page.locator('#options-button'));

    await page.evaluate(() => { window.copyMode = 'failure'; });
    await open(); await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('[data-player-action="copy-debug"] span').textContent === 'Try copying again');
    await page.waitForTimeout(1100); assert.equal(await menu.isVisible(), true); await focused(copy);
    await page.evaluate(() => { window.copyMode = 'success'; });
    await page.keyboard.press('Enter'); await menu.waitFor({ state: 'hidden' }); await focused(player);

    await page.evaluate(() => { window.copyMode = 'pending'; });
    await open(); await page.keyboard.press('Enter'); await page.waitForFunction(() => window.finishCopy);
    await page.keyboard.press('Escape'); await focused(player);
    await open(); await page.evaluate(() => window.finishCopy());
    await page.waitForTimeout(1100);
    assert.equal(await menu.isVisible(), true); assert.equal(await copy.locator('span').textContent(), 'Copy debug info');
    await page.keyboard.press('Escape'); await focused(player);

    await page.evaluate(() => { window.copyMode = 'success'; });
    await copied(); await tabTo(page.locator('#options-button'));
    await menu.evaluate(node => { window.disconnectedCopyMenu = node; node.remove(); });
    await page.waitForTimeout(1100); await focused(page.locator('#options-button'));
    assert.equal(await page.evaluate(() => window.disconnectedCopyMenu.hidden), true);
    await player.evaluate(node => node.insertBefore(window.disconnectedCopyMenu, node.querySelector('#player-stats')));
    await waitForPlayer(page, ({ app }) => app.video === window.copyFocusOriginal.video && app.hls === window.copyFocusOriginal.decoder &&
      app.pageReplay.session.session_id === window.copyFocusOriginal.token && app.video.paused);
    assert.deepEqual(errors, []);
    console.log(`${name}: Copy feedback preserves later keyboard scrub/control focus, owns normal dismissal, and retains failed retry, Escape, late-menu and disconnect cleanup.`);
  } finally { await page.close(); }
}

for (const [name, engine] of Object.entries({ chromium, webkit })) {
  const browser = await engine.launch({ headless: true, args: name === 'chromium' ? ['--no-sandbox'] : [] });
  try {
    await menuAndStats(browser);
    await onboarding(browser, name);
    await rejectedSetup(browser);
    await rejectedBackend(browser, name);
    await copyFeedbackFocus(browser, name);
    console.log(`${name}: available menu actions, keyboard Stats focus, pending onboarding ownership/cancellation and failed printer-editor focus passed.`);
  } finally { await browser.close(); }
}
