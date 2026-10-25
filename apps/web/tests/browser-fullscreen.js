import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { waitForPlayer } from './player-page.js';

const base = process.env.VIEWER_URL || 'http://127.0.0.1:8080';

async function ready(page) {
  await page.goto(base);
  await page.waitForFunction(() => {
    const video = document.querySelector('video');
    return video.readyState >= 2 && video.videoWidth > 0 && !video.paused && document.querySelector('#overlay').hidden;
  }, undefined, { timeout: 45000 });
  await page.evaluate(async () => {
    const app = await import('/static/player.js');
    window.originalFullscreenMedia = { video: app.video, decoder: app.hls, source: app.video.currentSrc,
      session: app.pageReplay.session.session_id, updates: app.updates.source };
  });
}

async function sameMedia(page) {
  assert.equal(await page.evaluate(async () => {
    const app = await import('/static/player.js');
    const original = window.originalFullscreenMedia;
    return app.video === original.video && app.hls === original.decoder && app.video.currentSrc === original.source &&
      app.pageReplay.session.session_id === original.session && app.updates.source === original.updates &&
      !app.video.controls && !app.playerFullscreen.miniActive();
  }), true, 'Fullscreen must retain the native decoder, source, history, updates and inline custom controls.');
}

async function inactive(page) {
  await waitForPlayer(page, ({ app }) => !app.playerFullscreen.active() && !app.playerFullscreen.nativeRequested);
  assert.equal(await page.locator('#fullscreen-button').getAttribute('aria-label'), 'Enter fullscreen');
  assert.equal(await page.locator('.native-fullscreen').count(), 0);
}

// Desktop WebKit emulation cannot display iPhone's OS fullscreen surface.
// Supply only its fullscreen capabilities; use real playback and trusted taps
// to verify the API choice, gesture, lifecycle and media continuity in both engines.
async function safariFallback(browser, mode) {
  const page = await browser.newPage({ viewport: { width: 414, height: 896 }, isMobile: true, hasTouch: true });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(mode => {
    let landscape = false;
    let native = false;
    let element = null;
    window.fullscreenCalls = [];
    window.nativeShouldFail = mode === 'native-denied';
    const orientation = new EventTarget();
    Object.defineProperty(orientation, 'type', { get: () => landscape ? 'landscape-primary' : 'portrait-primary' });
    Object.defineProperty(screen, 'orientation', { value: orientation, configurable: true });
    window.rotatePhone = value => {
      landscape = value;
      orientation.dispatchEvent(new Event('change'));
      window.dispatchEvent(new Event('orientationchange'));
    };
    Object.defineProperty(document, 'fullscreenElement', { get: () => null, configurable: true });
    Object.defineProperty(document, 'webkitFullscreenElement', { get: () => element, configurable: true });
    Object.defineProperty(document, 'fullscreenEnabled', { value: mode === 'element-denied', configurable: true });
    Object.defineProperty(document, 'webkitFullscreenEnabled', { value: mode === 'webkit-element', configurable: true });
    Element.prototype.requestFullscreen = mode === 'element-denied' ? function () {
      window.fullscreenCalls.push({ action: 'element-enter' });
      return Promise.reject(new DOMException('Element fullscreen unavailable', 'NotSupportedError'));
    } : undefined;
    Element.prototype.webkitRequestFullscreen = mode === 'webkit-element' ? function () {
      window.fullscreenCalls.push({ action: 'webkit-element-enter', activated: navigator.userActivation?.isActive });
      element = this;
      document.dispatchEvent(new Event('webkitfullscreenchange'));
    } : undefined;
    document.webkitExitFullscreen = () => {
      window.fullscreenCalls.push({ action: 'webkit-element-exit' });
      element = null;
      document.dispatchEvent(new Event('webkitfullscreenchange'));
    };
    Object.defineProperty(HTMLVideoElement.prototype, 'webkitDisplayingFullscreen', { get: () => native, configurable: true });
    Object.defineProperty(HTMLVideoElement.prototype, 'webkitSupportsFullscreen', { get: () => true, configurable: true });
    HTMLVideoElement.prototype.webkitEnterFullscreen = function () {
      window.fullscreenCalls.push({ action: 'native-enter', activated: navigator.userActivation?.isActive });
      if (window.nativeShouldFail) throw new DOMException('Denied by browser', 'NotAllowedError');
      const enter = () => { native = true; this.dispatchEvent(new Event('webkitbeginfullscreen')); };
      if (mode === 'native-pending') window.completeNativeFullscreen = enter;
      else enter();
    };
    HTMLVideoElement.prototype.webkitExitFullscreen = function () {
      window.fullscreenCalls.push({ action: 'native-exit' });
      native = false;
      this.dispatchEvent(new Event('webkitendfullscreen'));
    };
    window.browserExitFullscreen = () => {
      native = false;
      document.querySelector('video').dispatchEvent(new Event('webkitendfullscreen'));
    };
  }, mode);
  try {
    await ready(page);
    await page.getByRole('button', { name: 'Enter fullscreen', exact: true }).tap();
    if (mode === 'webkit-element') {
      await page.waitForFunction(() => document.webkitFullscreenElement?.id === 'player');
      assert.equal(await page.locator('.native-fullscreen').count(), 0);
      assert.equal(await page.locator('#player-toolbar').isVisible(), true);
      assert.deepEqual(await page.evaluate(() => window.fullscreenCalls), [{ action: 'webkit-element-enter', activated: true }]);
      await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).tap();
      await inactive(page);
    } else if (mode === 'native-pending') {
      await waitForPlayer(page, ({ app }) => app.playerFullscreen.nativeRequested);
      await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).tap();
      await page.evaluate(() => window.completeNativeFullscreen());
      await inactive(page);
      assert.deepEqual(await page.evaluate(() => window.fullscreenCalls.map(call => call.action)), ['native-enter', 'native-exit'],
        'Exit during a pending native entry must cancel it once Safari enters.');
      await page.evaluate(() => window.rotatePhone(true));
      // Rotation keeps the full-window custom player; its button escalates to native fullscreen.
      assert.equal(await page.locator('#fullscreen-button').getAttribute('aria-label'), 'Enter fullscreen');
      await page.getByRole('button', { name: 'Enter fullscreen', exact: true }).tap();
      await page.evaluate(() => { window.rotatePhone(false); window.completeNativeFullscreen(); });
      await inactive(page);
    } else {
      if (mode === 'native-denied') {
        await waitForPlayer(page, ({ app }) => !app.playerFullscreen.entering && !app.playerFullscreen.nativeRequested);
        assert.equal(await page.locator('.native-fullscreen').count(), 0);
        assert.equal(await page.locator('#fullscreen-button').getAttribute('aria-label'), 'Enter fullscreen',
          'A rejected request must offer a retry rather than claim real fullscreen.');
        await page.evaluate(() => { window.nativeShouldFail = false; });
        await page.getByRole('button', { name: 'Enter fullscreen', exact: true }).tap();
      }
      await page.waitForFunction(() => document.querySelector('#player').classList.contains('native-fullscreen'));
      assert.equal(await page.locator('.expanded').count(), 0);
      assert.equal(await page.locator('#fullscreen-button').getAttribute('aria-label'), 'Exit fullscreen');
      assert.equal(await page.evaluate(() => window.fullscreenCalls.filter(call => call.action === 'native-enter')
        .every(call => call.activated)), true, 'Native fullscreen must retain the trusted tap activation.');
      await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).tap();
      await inactive(page);
      // Native browser Done/back exits independently from our button.
      await page.getByRole('button', { name: 'Enter fullscreen', exact: true }).tap();
      await page.evaluate(() => window.browserExitFullscreen());
      await inactive(page);
      if (mode === 'native') {
        const callsBeforeRotation = await page.evaluate(() => window.fullscreenCalls.length);
        await page.evaluate(() => window.rotatePhone(true));
        assert.equal(await page.locator('.expanded').count(), 1);
        assert.equal(await page.locator('#replay-slider').isVisible(), true);
        assert.equal(await page.evaluate(() => window.fullscreenCalls.length), callsBeforeRotation,
          'Automatic rotation must preserve custom controls when whole-player fullscreen is unavailable.');
        await page.getByRole('button', { name: 'Enter fullscreen', exact: true }).tap();
        await page.waitForFunction(() => document.querySelector('video').webkitDisplayingFullscreen);
        await page.evaluate(() => window.rotatePhone(false));
        await inactive(page);
      }
    }
    await sameMedia(page);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
}

async function realFullscreen(browser) {
  const page = await browser.newPage({ viewport: { width: 414, height: 896 }, isMobile: true, hasTouch: true });
  try {
    await ready(page);
    await page.getByRole('button', { name: 'Enter fullscreen', exact: true }).tap();
    await page.waitForFunction(() => document.fullscreenElement?.id === 'player');
    assert.equal(await page.locator('#player-toolbar').evaluate(toolbar => Boolean(toolbar.closest(':fullscreen'))), true);
    await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).tap();
    await inactive(page);
    await sameMedia(page);
    console.log('chromium: trusted mobile tap enters/exits real whole-player fullscreen with custom controls.');
  } finally { await page.close(); }
}

for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) {
  const browser = await engine.launch({ headless: true, args: name === 'chromium' ? ['--no-sandbox'] : [] });
  try {
    if (name === 'chromium') await realFullscreen(browser);
    for (const mode of ['native', 'native-pending', 'element-denied', 'native-denied', 'webkit-element']) {
      await safariFallback(browser, mode);
    }
    console.log(`${name}: iPhone video fallback, trusted tap activation, browser/button/portrait exit, pending entry cancellation, rejected requests, prefixed whole-player priority, rotation escalation and unchanged media passed.`);
  } finally { await browser.close(); }
}
