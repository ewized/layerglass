import { waitForPlayer } from './player-page.js';
import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';

const base = process.env.VIEWER_URL || 'http://127.0.0.1:8080';

async function ready(page) {
  await page.goto(base);
  await page.waitForFunction(() => {
    const video = document.querySelector('video');
    return video.videoWidth > 0 && video.readyState >= 2 && !video.paused && document.querySelector('#overlay').hidden;
  },
    undefined, { timeout: 45000 });
}

// Supply browser capabilities so both engines can exercise iPhone-style lack
// of element fullscreen, activation rejection, and a pending request.
async function simulated(browser, mode, mobile = true, legacy = false) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: mobile, isMobile: mobile });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(({ mode, legacy }) => {
    let landscape = false;
    let fullscreen = null;
    let finishEntry;
    window.fullscreenCalls = [];
    const orientation = new EventTarget();
    Object.defineProperty(orientation, 'type', { get: () => landscape ? 'landscape-primary' : 'portrait-primary' });
    Object.defineProperty(screen, 'orientation', { value: legacy ? undefined : orientation, configurable: true });
    Object.defineProperty(window, 'orientation', { get: () => landscape ? 90 : 0, configurable: true });
    window.rotatePhone = value => {
      landscape = value;
      if (!legacy) orientation.dispatchEvent(new Event('change'));
      window.dispatchEvent(new Event('orientationchange'));
    };
    Object.defineProperty(document, 'fullscreenElement', { get: () => fullscreen, configurable: true });
    Object.defineProperty(document, 'webkitFullscreenElement', { get: () => null, configurable: true });
    Object.defineProperty(document, 'fullscreenEnabled', { value: mode !== 'in-page', configurable: true });
    Object.defineProperty(document, 'webkitFullscreenEnabled', { value: false, configurable: true });
    Element.prototype.requestFullscreen = function () {
      window.fullscreenCalls.push('enter');
      if (mode === 'deny' && window.fullscreenCalls.filter(call => call === 'enter').length === 1) {
        return Promise.reject(new DOMException('A tap is required', 'NotAllowedError'));
      }
      const enter = () => { fullscreen = this; document.dispatchEvent(new Event('fullscreenchange')); };
      if (mode === 'pending') return new Promise(resolve => { finishEntry = () => { enter(); resolve(); }; });
      enter();
      return Promise.resolve();
    };
    document.exitFullscreen = async () => {
      window.fullscreenCalls.push('exit');
      fullscreen = null;
      document.dispatchEvent(new Event('fullscreenchange'));
    };
    HTMLVideoElement.prototype.webkitEnterFullscreen = function () {
      window.fullscreenCalls.push('native-enter');
      throw new Error('Video-only fullscreen must not replace the custom controls.');
    };
    // This scenario represents browsers without any real fullscreen surface.
    // iPhone's available video fullscreen is covered by browser-fullscreen.js.
    Object.defineProperty(HTMLVideoElement.prototype, 'webkitSupportsFullscreen', { get: () => false, configurable: true });
    HTMLVideoElement.prototype.webkitExitFullscreen = function () {
      window.fullscreenCalls.push('native-exit');
    };
    window.completeFullscreen = () => finishEntry();
  }, { mode, legacy });
  try {
    await ready(page);
    await page.setViewportSize({ width: 844, height: 390 });
    await page.evaluate(() => window.rotatePhone(true));
    if (!mobile) {
      assert.deepEqual(await page.evaluate(() => window.fullscreenCalls), [], 'Desktop rotation/resize must not enter fullscreen.');
      assert.equal(await page.evaluate(async () => {
      const { playerFullscreen } = await import('/static/player.js');
      return (playerFullscreen.inPage);
    }), false);
      return;
    }
    if (mode === 'deny') {
      await waitForPlayer(page, ({ app }) => {
      const { playerFullscreen } = app;
      return (playerFullscreen.retryOnTap);
    });
      assert.equal(await page.locator('#fullscreen-button').getAttribute('aria-label'), 'Exit fullscreen');
      assert.equal(await page.evaluate(async () => {
      const { playerFullscreen } = await import('/static/player.js');
      return (playerFullscreen.inPage);
    }), true, 'A denied request must keep our full-window player available.');
      // Options and their controls must not consume the pending fullscreen gesture.
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      assert.deepEqual(await page.evaluate(() => window.fullscreenCalls), ['enter']);
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await page.locator('video').tap();
    }
    if (mode === 'pending') {
      await page.evaluate(() => { window.rotatePhone(false); window.completeFullscreen(); });
      await waitForPlayer(page, ({ app }) => {
      const { playerFullscreen } = app;
      return (!document.fullscreenElement && !playerFullscreen.entering);
    });
      assert.deepEqual(await page.evaluate(() => window.fullscreenCalls), ['enter', 'exit']);
      assert.equal(await page.locator('#player').evaluate(player => player.classList.contains('expanded')), false);
      return;
    }
    await waitForPlayer(page, ({ app, arg: mode }) => {
      const { playerFullscreen } = app;
      return (mode === 'in-page' ? playerFullscreen.inPage : playerFullscreen.browserFullscreen());
    }, mode);
    assert.equal(await page.locator('#fullscreen-button').getAttribute('aria-label'), 'Exit fullscreen');
    assert.equal(await page.locator('video').evaluate(video => video.controls), false, 'Native video controls must stay disabled.');
    if (mode === 'in-page') {
      const geometry = await page.locator('#player').evaluate(player => {
        const rect = player.getBoundingClientRect();
        return { expanded: player.classList.contains('expanded'), x: rect.x, y: rect.y,
          width: rect.width, height: rect.height, viewportWidth: innerWidth, viewportHeight: innerHeight };
      });
      assert.equal(geometry.expanded, true);
      assert.equal(geometry.x, 0);
      assert.equal(geometry.y, 0);
      assert(Math.abs(geometry.width - geometry.viewportWidth) < 1 && Math.abs(geometry.height - geometry.viewportHeight) < 1);
      await page.mouse.move(20, 20);
      assert.equal(await page.locator('#replay-slider').isVisible(), true);
      await page.getByRole('button', { name: 'Pause video', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('video').paused);
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await page.getByRole('dialog', { name: 'Settings' }).waitFor({ state: 'visible' });
      await page.keyboard.press('Escape');
      assert.equal(await page.evaluate(async () => {
      const { playerFullscreen } = await import('/static/player.js');
      return (playerFullscreen.inPage);
    }), true, 'Escape must close options before leaving the expanded view.');
      await page.getByRole('button', { name: 'Return to live video', exact: true }).click();
      await page.waitForFunction(() => !document.querySelector('video').paused);
    } else {
      assert.equal(await page.evaluate(() => document.fullscreenElement?.id), 'player', 'Fullscreen must include the entire custom player.');
      assert.equal(await page.evaluate(async () => {
      const { playerFullscreen } = await import('/static/player.js');
      return (playerFullscreen.inPage);
    }), false);
    }
    await page.evaluate(() => window.rotatePhone(false));
    await waitForPlayer(page, ({ app }) => {
      const { playerFullscreen } = app;
      return (!playerFullscreen.active());
    });
    assert.equal(await page.locator('video').evaluate(video => video.controls), false);
    assert.equal(await page.locator('#fullscreen-button').getAttribute('aria-label'), 'Enter fullscreen');
    const expected = mode === 'in-page' ? [] : mode === 'deny' ? ['enter', 'enter', 'exit'] : ['enter', 'exit'];
    assert.deepEqual(await page.evaluate(() => window.fullscreenCalls), expected, 'Duplicate orientation events must not double-enter.');
    assert.equal(await page.locator('#player').evaluate(player => player.classList.contains('expanded')), false);
    if (mode === 'in-page') {
      await page.evaluate(() => window.rotatePhone(true));
      await page.mouse.move(20, 20);
      await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).click();
      await page.evaluate(() => window.rotatePhone(true));
      assert.equal(await page.evaluate(async () => {
      const { playerFullscreen } = await import('/static/player.js');
      return (playerFullscreen.active());
    }), false, 'Manual exit must persist until another rotation.');
      await page.evaluate(() => window.rotatePhone(false));
      await page.getByRole('button', { name: 'Enter fullscreen', exact: true }).click();
      assert.equal(await page.evaluate(async () => {
      const { playerFullscreen } = await import('/static/player.js');
      return (playerFullscreen.inPage);
    }), true);
      await page.keyboard.press('Escape');
      assert.equal(await page.evaluate(async () => {
      const { playerFullscreen } = await import('/static/player.js');
      return (playerFullscreen.active());
    }), false);
      assert.deepEqual(await page.evaluate(() => window.fullscreenCalls), [], 'The native video API must never be called.');
    }
    if (mode === 'standard') {
      // Exiting with the fullscreen button must not be undone by another event
      // for the same landscape orientation.
      await page.evaluate(() => window.rotatePhone(true));
      await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).click();
      await page.evaluate(() => window.rotatePhone(true));
      assert.equal(await page.evaluate(async () => {
      const { playerFullscreen } = await import('/static/player.js');
      return (!!playerFullscreen.active());
    }), false);
      await page.evaluate(() => { window.rotatePhone(false); document.querySelector('#overlay').hidden = false; window.rotatePhone(true); });
      assert.equal(await page.evaluate(async () => {
      const { playerFullscreen } = await import('/static/player.js');
      return (!!playerFullscreen.active());
    }), false, 'An empty/connecting player must not auto-fullscreen.');
    }
  } catch (error) {
    console.error('Fullscreen scenario', { mode, mobile, legacy }, await page.evaluate(async () => {
      const { playerFullscreen } = await import('/static/player.js');
      return (({
      calls: window.fullscreenCalls, touchDevice: playerFullscreen.touchDevice,
      landscape: playerFullscreen.landscape(), lastLandscape: playerFullscreen.lastLandscape,
      active: !!playerFullscreen.active(), entering: playerFullscreen.entering,
      retryOnTap: playerFullscreen.retryOnTap, inPage: playerFullscreen.inPage,
      hidden: document.hidden, videoHidden: document.querySelector('video').hidden,
      readyState: document.querySelector('video').readyState, overlayHidden: document.querySelector('#overlay').hidden
    }));
    }));
    throw error;
  } finally {
    assert.deepEqual(errors, []);
    await page.close();
  }
}

async function realRotation(browser) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  try {
    const client = await page.context().newCDPSession(page);
    const rotate = landscape => client.send('Emulation.setDeviceMetricsOverride', {
      width: landscape ? 844 : 390, height: landscape ? 390 : 844,
      screenWidth: landscape ? 844 : 390, screenHeight: landscape ? 390 : 844,
      deviceScaleFactor: 1, mobile: true,
      screenOrientation: { type: landscape ? 'landscapePrimary' : 'portraitPrimary', angle: landscape ? 90 : 0 }
    });
    await rotate(false);
    await ready(page);
    await rotate(true);
    await waitForPlayer(page, ({ app }) => {
      const { playerFullscreen } = app;
      return (document.fullscreenElement || playerFullscreen.retryOnTap);
    });
    const tapRequired = await page.evaluate(async () => {
      const { playerFullscreen } = await import('/static/player.js');
      return (playerFullscreen.retryOnTap);
    });
    if (tapRequired) await page.locator('video').tap();
    await page.waitForFunction(() => document.fullscreenElement?.id === 'player');
    assert.equal(await page.locator('video').evaluate(video => video.controls), false);
    assert.equal(await page.locator('#player-toolbar').evaluate(toolbar => !!toolbar.closest(':fullscreen')), true);
    await rotate(false);
    await page.waitForFunction(() => !document.fullscreenElement);
    assert.equal(await page.locator('#fullscreen-button').getAttribute('aria-label'), 'Enter fullscreen');
    console.log(`chromium: real fullscreen entered${tapRequired ? ' after browser-required tap' : ' on rotation'} and exited on portrait`);
  } finally { await page.close(); }
}

(async () => {
  for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await engine.launch({ headless: true, args: name === 'chromium' ? ['--no-sandbox'] : [] });
    try {
      if (name === 'chromium') await realRotation(browser);
      for (const mode of ['standard', 'in-page', 'deny', 'pending']) await simulated(browser, mode);
      await simulated(browser, 'in-page', true, true);
      await simulated(browser, 'standard', false);
      console.log(`${name}: landscape/portrait, full-window fallback with custom controls, pause/Live/options, no native video API, tap retry, pending rotation, legacy orientation, manual/Escape exit, empty player and desktop exclusion passed`);
    } finally { await browser.close(); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
