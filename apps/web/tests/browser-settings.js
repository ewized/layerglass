import { waitForPlayer } from './player-page.js';
import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
const base = process.env.VIEWER_URL || 'http://127.0.0.1:8080';

async function playing(page) {
  await page.waitForFunction(() => document.querySelector('video').videoWidth > 0 && !document.querySelector('video').paused &&
    document.querySelector('#overlay').hidden, undefined, { timeout: 45000 });
}

async function contextMenu(page, position) {
  const box = await page.locator('#player').boundingBox();
  await page.mouse.click(box.x + position.x, box.y + position.y, { button: 'right' });
  await page.locator('#video-context-menu').waitFor({ state: 'visible' });
}

async function shot(page, name, view) {
  if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/${name}-${view}.png` });
}

async function run(name, engine) {
  const browser = await engine.launch({ headless: true, args: name === 'chromium' ? ['--no-sandbox'] : [] });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  // These engines lack the OS PiP surface in their mobile test shells. Model
  // its documented state/events here; browser-video-pip.js opens real PiP.
  await page.addInitScript(mode => {
    window.pipCalls = [];
    let element = null;
    let presentation = 'inline';
    Object.defineProperty(window, 'documentPictureInPicture', { value: undefined, configurable: true });
    Object.defineProperty(document, 'pictureInPictureEnabled', { get: () => mode === 'standard', configurable: true });
    Object.defineProperty(document, 'pictureInPictureElement', { get: () => element, configurable: true });
    HTMLVideoElement.prototype.requestPictureInPicture = async function() {
      window.pipCalls.push('standard');
      if (mode !== 'standard') throw new Error('Safari must use its presentation API.');
      element = this;
      this.dispatchEvent(new Event('enterpictureinpicture'));
      return { width: 420, height: 236 };
    };
    document.exitPictureInPicture = async () => {
      window.pipCalls.push('exit');
      const previous = element;
      element = null;
      previous.dispatchEvent(new Event('leavepictureinpicture'));
    };
    Object.defineProperty(HTMLVideoElement.prototype, 'webkitPresentationMode', { get: () => presentation, configurable: true });
    HTMLVideoElement.prototype.webkitSupportsPresentationMode = value => value === 'picture-in-picture';
    HTMLVideoElement.prototype.webkitSetPresentationMode = function(value) {
      window.pipCalls.push(value);
      presentation = value;
      this.dispatchEvent(new Event('webkitpresentationmodechanged'));
    };
  }, name === 'chromium' ? 'standard' : 'webkit');
  const errors = [];
  const requests = [];
  const scanLogs = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.text().includes('[LayerGlass] Printer scan')) scanLogs.push(message.text()); });
  page.on('request', request => requests.push(new URL(request.url()).pathname));
  try {
    await page.goto(base);
    await playing(page);
    assert.equal(await page.locator('#camera-name').textContent(), 'Bambu Lab X2D');
    assert.equal(await page.locator('#camera-id').textContent(), '20P000000000001');
    assert.equal(await page.locator('body').innerText().then(text => text.includes('192.168.50.')), false);
    assert.equal(await page.locator('#options-button use').getAttribute('href'), '#i-settings');
    assert.equal(await page.locator('#pause-button').evaluate(button => button.textContent.trim()), '');
    assert.equal(await page.locator('#pause-button .pause-icon').isVisible(), true);
    await page.mouse.move(10, 10);
    await page.locator('#pause-button').click();
    await page.waitForFunction(() => document.querySelector('#pause-button').classList.contains('paused'));
    assert.equal(await page.locator('#pause-button .play-icon').isVisible(), true);
    await page.locator('#pause-button').click();
    await playing(page);
    assert.equal(requests.filter(path => path === '/api/discover').length, 0);
    await page.locator('#options-button').click();
    assert.equal(await page.locator('#settings-title').textContent(), 'Settings');
    assert.equal(await page.locator('#player-options use[href="#i-close"]').count(), 0);
    assert.equal(await page.locator('#player-options [data-player-action]').count(), 0);
    assert.deepEqual(await page.locator('[data-settings-page="root"] [data-settings-target]').evaluateAll(rows => rows.map(row => row.dataset.settingsTarget)), ['printers', 'backends']);
    assert.equal(await page.locator('#scan-button').isVisible(), false);
    assert.equal(await page.locator('.printer-code-form input:visible').count(), 0);
    assert.equal(await page.locator('#refresh-button').isVisible(), true);
    assert.equal(await page.locator('body').innerText().then(text => text.includes('192.168.50.')), false);
    await shot(page, name, 'settings');
    const session = await page.evaluate(async () => {
      const { pageReplay } = await import('/static/player.js');
      return (pageReplay.session.session_id);
    });
    await page.locator('#printers-button').click();
    await waitForPlayer(page, ({ app }) => {
      const { scanPending } = app;
      return (!scanPending);
    });
    assert.equal(requests.filter(path => path === '/api/discover').length, 1, 'Entering Printers must discover implicitly.');
    const rows = page.locator('#camera-list [data-camera-id]');
    assert.equal(await rows.count(), 2);
    assert.deepEqual(await rows.locator('.printer-address').allTextContents(), ['192.168.50.2:322', '192.168.50.3:322']);
    assert.equal(await page.evaluate(async () => {
      const { pageReplay } = await import('/static/player.js');
      return (pageReplay.session.session_id);
    }), session, 'Opening discovery must keep the active camera buffer.');
    await shot(page, name, 'printers');
    const first = await rows.first().getAttribute('data-camera-id');
    assert.equal(await rows.first().locator('.printer-access').isVisible(), false);
    assert.equal(await rows.first().locator('.printer-state').isVisible(), true);
    assert.equal(await rows.first().locator('.printer-forget').isVisible(), true);
    assert.equal(await rows.nth(1).locator('.printer-select').isDisabled(), true);
    assert.equal(await page.locator('.printer-code-form input:visible').count(), 0, 'Opening Printers must not open a code field.');
    await rows.nth(1).locator('.printer-access').click();
    const code = rows.nth(1).locator('input');
    await code.waitFor({ state: 'visible' });
    assert.equal(await page.locator('#settings-title').textContent(), 'Printers');
    assert.equal(await code.getAttribute('type'), 'text');
    assert.equal(await page.locator('#camera-name').textContent(), 'Bambu Lab X2D');
    assert.equal(await page.evaluate(async () => (await import('/static/player.js')).pageReplay.session.session_id), session,
      'Entering another printer’s access code must keep the current feed and buffer.');
    await code.fill('draft-code');
    await code.evaluate(input => { window.draftInput = input; input.setSelectionRange(2, 5); });
    await page.evaluate(async () => {
      const { updates } = await import('/static/player.js');
      const catalog = await (await fetch('/api/cameras')).json();
      catalog.cameras[1].name = 'Studio X1 updated';
      updates.source.dispatchEvent(new MessageEvent('state', { data: JSON.stringify({ version: 1, catalog }) }));
    });
    assert.equal(await rows.nth(1).locator('.printer-name').textContent(), 'Studio X1 updated');
    assert.deepEqual(await code.evaluate(input => ({ same: input === window.draftInput, focused: document.activeElement === input,
      value: input.value, start: input.selectionStart, end: input.selectionEnd })),
    { same: true, focused: true, value: 'draft-code', start: 2, end: 5 }, 'Pushed discovery updates must preserve the inline draft and keyboard focus.');
    await shot(page, name, 'printer-access');
    await page.keyboard.press('Escape');
    assert.equal(await code.isVisible(), false);
    assert.equal(await code.inputValue(), '');
    assert.equal(await page.locator('#settings-title').textContent(), 'Printers');
    await page.locator('#settings-back').click();
    assert.equal(await page.locator('#settings-title').textContent(), 'Settings');
    assert.equal(requests.filter(path => path === '/api/discover').length, 1, 'Back navigation must not start another scan.');
    await page.locator('#printers-button').click();
    await page.locator(`[data-camera-id="${first}"] .printer-select`).click();
    await playing(page);
    await page.mouse.move(10, 10);
    await page.locator('#options-button').click();
    await page.locator('[data-settings-target="backends"]').click();
    assert.equal(await page.locator('#refresh-button').isVisible(), false);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#settings-title').textContent(), 'Settings');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#player-options').isVisible(), false);

    await contextMenu(page, { x: 380, y: 830 });
    assert.deepEqual(await page.locator('#video-context-menu [role="menuitem"]').allTextContents(), ['Mini player', 'Stats for nerds', 'Copy debug info']);
    const geometry = await page.locator('#video-context-menu').evaluate(menu => {
      const box = menu.getBoundingClientRect();
      return box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight;
    });
    assert.equal(geometry, true, 'The custom context menu must fit at the lower-right edge.');
    await page.locator('#video-context-menu [data-player-action="stats"]').click();
    await page.locator('#player-stats').waitFor({ state: 'visible' });
    assert.deepEqual(await page.locator('#player-stats h3:visible').allTextContents(), ['Video', 'Printer']);
    assert.equal(await page.locator('[data-stats-section="video"] [data-stat="Resolution"]').textContent(), '640 × 360');
    assert.equal(await page.locator('[data-stats-section="printer"] [data-stat="Camera IP"]').textContent(), '192.168.50.2');
    assert.equal(await page.locator('.stats-section[aria-label="Activity"]').isVisible(), false);
    assert.equal(await page.locator('[data-stat="Printer scan"], [data-stat="Mini player"]').count(), 0);
    assert.equal(await page.locator('[data-stat="Updates"], [data-stat="Camera"]').count(), 0);
    assert(await page.locator('[data-stats-section="printer"] dd').count() <= 26);
    // Historical printer readings arrive asynchronously over SSE/history;
    // opening Stats must not assume they are present on its first render.
    await page.waitForFunction(() => document.querySelector('[data-stat="Model"]')?.textContent === 'Bambu Lab X2D' &&
      document.querySelector('[data-stat="Print State"]')?.textContent === 'RUNNING', undefined, { timeout: 15000 });
    assert.equal(await page.locator('[data-stat="Model"]').textContent(), 'Bambu Lab X2D');
    assert.equal(await page.locator('[data-stat="Firmware"]').textContent(), '01.01.00.80');
    assert.equal(await page.locator('[data-stat="Print State"]').textContent(), 'RUNNING');
    assert.equal(await page.locator('[data-stat="Progress"]').textContent(), '42%');
    assert.equal(await page.locator('[data-stat="Remaining Minutes"]').textContent(), '1h 23m 0s');
    assert.equal(await page.locator('[data-stat="Nozzle"]').textContent(), '210 / 215 °C (410 / 419 °F)');
    assert.equal(await page.locator('[data-stat="Bed"]').textContent(), '60 / 60 °C (140 / 140 °F)');
    assert.equal(await page.locator('[data-stat="Layer"]').textContent(), '21 / 50');
    scanLogs.length = 0;
    await page.evaluate(async () => {
      const { updates } = await import('/static/player.js');
      window.scanFixture = await (await fetch('/api/cameras')).json();
      for (let checked = 0; checked <= 43; checked++) {
        const catalog = { ...window.scanFixture, discovery: { ...window.scanFixture.discovery, state: 'scanning', checked, total: 100 } };
        updates.source.dispatchEvent(new MessageEvent('state', { data: JSON.stringify({ version: 1, catalog }) }));
      }
    });
    await page.waitForFunction(() => document.querySelector('[data-stat="Printer scan"]')?.textContent === 'Scanning · 43%');
    assert.deepEqual(await page.locator('#player-stats h3:visible').allTextContents(), ['Video', 'Printer', 'Activity']);
    assert.equal(await page.locator('[data-stats-section="activity"] [data-stat="Printer scan"]').textContent(), 'Scanning · 43%');
    assert.equal(await page.locator('[data-stats-section="printer"] [data-stat="Printer scan"]').count(), 0);
    assert.equal(await page.locator('[data-stat="Mini player"]').count(), 0);
    assert.deepEqual(scanLogs, ['[LayerGlass] Printer scan started']);
    assert.equal(await page.locator('#discovery-message').textContent(), 'Scanning for printer cameras…');
    await page.evaluate(async () => {
      const { updates } = await import('/static/player.js');
      const catalog = { ...window.scanFixture,
        discovery: { ...window.scanFixture.discovery, state: 'scanning', checked: 43, total: 100, cached: 37 } };
      updates.source.dispatchEvent(new MessageEvent('state', { data: JSON.stringify({ version: 1, catalog }) }));
    });
    assert.equal(await page.locator('[data-stat="Printer scan"]').textContent(), 'Scanning · 43% · 37 cached');
    assert.deepEqual(scanLogs, ['[LayerGlass] Printer scan started'], 'Cache progress must not add console messages.');
    await page.evaluate(async () => (await import('/static/player.js')).playerTools.toggleMini());
    assert.equal(await page.locator('[data-stats-section="activity"] [data-stat="Mini player"]').textContent(), 'Active');
    assert.equal(await page.locator('[data-stats-section="activity"] dd').count(), 2,
      'Simultaneous scan and mini mode must show both activities.');
    await page.evaluate(async () => {
      const { updates } = await import('/static/player.js');
      const catalog = { ...window.scanFixture, discovery: { ...window.scanFixture.discovery, state: 'done', checked: 100, total: 100 } };
      updates.source.dispatchEvent(new MessageEvent('state', { data: JSON.stringify({ version: 1, catalog }) }));
    });
    await page.waitForFunction(() => !document.querySelector('[data-stat="Printer scan"]'));
    assert.equal(await page.locator('.stats-section[aria-label="Activity"]').isVisible(), true,
      'Finishing a scan must keep the section while the mini player is active.');
    assert.deepEqual(await page.locator('[data-stats-section="activity"] dt').allTextContents(), ['Mini player']);
    assert.equal(scanLogs.length, 2);
    assert.equal(scanLogs[1].startsWith('[LayerGlass] Printer scan finished'), true);
    await page.evaluate(async () => (await import('/static/player.js')).playerTools.restoreMini());
    assert.equal(await page.locator('[data-stat="Mini player"]').count(), 0);
    assert.equal(await page.locator('.stats-section[aria-label="Activity"]').isVisible(), false,
      'Restoring the player must immediately remove the last activity and its section.');
    await page.evaluate(async () => {
      const app = await import('/static/player.js');
      const catalog = { ...window.scanFixture, cameras: window.scanFixture.cameras.map(camera =>
        camera.id === app.selectedCamera ? { ...camera, name: 'Enclosure X2D' } : camera) };
      app.updates.source.dispatchEvent(new MessageEvent('state', { data: JSON.stringify({ version: 1, catalog }) }));
    });
    assert.equal(await page.locator('#camera-name').textContent(), 'Bambu Lab X2D');
    assert.equal(await page.locator('#camera-id').textContent(), '20P000000000001');
    assert.equal(await page.locator('#camera-list .printer-name').first().textContent(), 'Enclosure X2D');
    assert.equal(await page.evaluate(async () => (await import('/static/player.js')).pageReplay.session.session_id), session,
      'Updating a printer name must not restart the video or its rewind buffer.');
    assert.match(await page.locator('[data-stat="Frames / dropped"]').textContent(), /^\d+ \/ \d+$/);
    const initialFrames = await page.locator('[data-stat="Frames / dropped"]').textContent();
    await page.waitForFunction(before => document.querySelector('[data-stat="Frames / dropped"]').textContent !== before, initialFrames);
    await contextMenu(page, { x: 260, y: 800 });
    await shot(page, name, 'stats-context');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#video-context-menu').isVisible(), false);
    assert.equal(await page.locator('#player-stats').isVisible(), true);
    await page.locator('#close-stats').click();

    // Browser PiP leaves our page toolbar available and restores without
    // fullscreen, replacing the video element, or discarding its history.
    await page.evaluate(() => {
      window.pipCalls = [];
      window.miniFullscreenCalls = 0;
      for (const name of ['requestFullscreen', 'webkitRequestFullscreen']) {
        const original = Element.prototype[name];
        if (original) Element.prototype[name] = function(...args) {
          window.miniFullscreenCalls++;
          return original.apply(this, args);
        };
      }
      const video = document.querySelector('video');
      window.miniVideo = video;
    });
    const token = await page.evaluate(async () => {
      const { pageReplay } = await import('/static/player.js');
      return (pageReplay.session.session_id);
    });
    await contextMenu(page, { x: 200, y: 300 });
    await page.locator('#video-context-menu [data-player-action="mini"]').click();
    await page.waitForFunction(() => document.querySelector('#player').classList.contains('mini-player'));
    assert.equal(await page.locator('video').evaluate(video => video.controls), false);
    assert.equal(await page.locator('video').getAttribute('disablepictureinpicture'), null);
    assert.equal(await page.locator('#player').evaluate(player => Math.round(player.getBoundingClientRect().width)), 390,
      'Video PiP must leave the page player full size instead of floating it inside the tab.');
    assert.equal(await page.locator('#replay-slider').isVisible(), true);
    await page.getByRole('button', { name: 'Pause video', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('video').paused);
    await page.waitForFunction(() => Number.isFinite(document.querySelector('video').duration));
    await page.locator('#replay-slider').press('Home');
    assert.equal(await page.evaluate(async () => (await import('/static/player.js')).pageReplay.followLive), false);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    assert.equal(await page.locator('#settings-title').textContent(), 'Settings');
    assert.equal(await page.locator('#player-options [data-player-action]').count(), 0);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Return to live video', exact: true }).click();
    await playing(page);
    await page.waitForFunction(() => document.querySelector('video').duration === Infinity);
    assert.deepEqual(await page.evaluate(() => window.pipCalls), [name === 'chromium' ? 'standard' : 'picture-in-picture']);
    assert.equal(await page.locator('#restore-player').count(), 0, 'Mini mode must not add a duplicate restore button.');
    assert.equal(await page.locator('#fullscreen-button use').getAttribute('href'), '#i-restore');
    const beforeRestore = await page.locator('video').evaluate(video => ({ time: video.currentTime, source: video.currentSrc }));
    await shot(page, name, 'mini');
    await page.getByRole('button', { name: 'Restore player', exact: true }).click();
    assert.equal(await page.evaluate(async () => {
      const { pageReplay } = await import('/static/player.js');
      return (pageReplay.session.session_id);
    }), token);
    assert.equal(await page.locator('#player').evaluate(player => player.classList.contains('mini-player')), false);
    assert.equal(await page.locator('#fullscreen-button').getAttribute('aria-label'), 'Enter fullscreen');
    assert.equal(await page.locator('#fullscreen-button use').getAttribute('href'), '#i-fullscreen');
    assert.deepEqual(await page.evaluate(() => window.pipCalls), name === 'chromium' ? ['standard', 'exit'] : ['picture-in-picture', 'inline']);
    assert.equal(await page.evaluate(() => window.miniFullscreenCalls), 0, 'Restoring any mini mode must not request fullscreen.');
    assert.equal(await page.evaluate(async () => {
      const { playerFullscreen } = await import('/static/player.js');
      return !!playerFullscreen.active();
    }), false);
    const afterRestore = await page.locator('video').evaluate(video => ({ time: video.currentTime, source: video.currentSrc }));
    assert.equal(await page.locator('video').evaluate(video => video === window.miniVideo), true, 'The same video element must keep decoding across Mini/Restore.');
    assert.equal(afterRestore.source, beforeRestore.source, 'Restoring must keep the same video source.');
    assert(afterRestore.time >= beforeRestore.time - 0.1, 'Restoring must not restart playback.');
    await playing(page);
    assert.deepEqual(errors, []);
    await page.goto('about:blank');
    const loading = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await loading.route('**/api/events**', route => route.abort());
    await loading.goto(base);
    await loading.locator('#loader').waitFor({ state: 'visible' });
    for (const id of ['overlay-title', 'overlay-subtitle']) {
      assert.equal(await loading.locator(`#${id}`).evaluate(node => getComputedStyle(node).clipPath), 'inset(50%)');
    }
    await shot(loading, name, 'loading');
    await loading.goto('about:blank');
    console.log(`${name}: settings, printer access codes, context menu/stats/activity, browser PiP API/events, page controls/restore, retained playback/history, and spinner-only loading passed`);
  } catch (error) {
    console.error(name, await page.evaluate(async () => {
      const { playerChrome, status } = await import('/static/player.js');
      return (({ settings: typeof playerChrome !== 'undefined' ? playerChrome.settings.page : null,
      title: document.querySelector('#overlay-title')?.textContent, state: typeof status !== 'undefined' ? status?.state : null }));
    }).catch(() => null));
    await shot(page, name, 'failure').catch(() => {});
    throw error;
  } finally { await browser.close(); }
}

Promise.all([run('chromium', chromium), run('webkit', webkit)]).catch(error => { console.error(error); process.exitCode = 1; });
