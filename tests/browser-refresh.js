import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';

const base = process.env.VIEWER_URL || 'http://127.0.0.1:8080';
const key = 'printerCameraReload';

async function playing(page) {
  await page.waitForFunction(() => {
    const video = document.querySelector('video');
    // During a full reload the custom player can still be upgrading.
    return video?.videoWidth > 0 && video.currentTime > 0 && !video.paused && document.querySelector('#overlay')?.hidden;
  }, undefined, { timeout: 45000 });
}

// WebKit's automation API lacks a physical swipe. Dispatch TouchEvent-shaped
// events there; Chromium additionally exercises a trusted CDP touch sequence.
async function gesture(page, { selector = 'video', points = [[180, 200], [180, 310]], cancel = false, multi = false } = {}) {
  return page.evaluate(({ selector, points, cancel, multi }) => {
    const target = document.querySelector(selector);
    const send = (type, point, count) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'touches', { value: Array.from({ length: count }, (_, identifier) =>
        ({ identifier, clientX: point[0], clientY: point[1], target })) });
      target.dispatchEvent(event);
    };
    send('touchstart', points[0], 1);
    for (const point of points.slice(1)) send('touchmove', point, multi ? 2 : 1);
    const visible = !document.querySelector('#pull-refresh').hidden;
    const label = document.querySelector('#pull-refresh-label').textContent;
    send(cancel ? 'touchcancel' : 'touchend', points.at(-1), 0);
    return { visible, label };
  }, { selector, points, cancel, multi });
}

async function run(name, engine) {
  const browser = await engine.launch({ headless: true, args: name === 'chromium' ? ['--no-sandbox'] : [] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.stateAtStartup = history.state;
    window.reloadPlayCalls = [];
    const mode = history.state?.testAutoplayMode;
    if (!history.state?.printerCameraReload?.autoplay) return;
    const original = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function() {
      this.autoplay = false; // Test the explicit retry, not the HTML autoplay attribute.
      window.reloadPlayCalls.push({ muted: this.muted, inline: this.playsInline, ready: this.readyState });
      if (mode === 'abort-once' && window.reloadPlayCalls.length === 1) {
        return Promise.reject(new DOMException('Initial load interrupted', 'AbortError'));
      }
      if (mode === 'blocked' && !window.allowUserPlayback) {
        this.pause();
        return Promise.reject(new DOMException('Gesture required', 'NotAllowedError'));
      }
      return original.call(this);
    };
  });
  try {
    await page.goto(base);
    await playing(page);
    const firstSession = await page.evaluate(async () => {
      const { pageReplay } = await import('/static/player.js');
      return (pageReplay.session.session_id);
    });
    const camera = await page.evaluate(async () => {
      const { selectedCamera } = await import('/static/player.js');
      return (selectedCamera);
    });
    let documents = 0;
    page.on('request', request => { if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documents++; });
    const rejected = [
      { points: [[180, 200], [180, 235]] },
      { points: [[180, 200], [180, 310], [180, 230]] },
      { points: [[180, 200], [280, 210], [280, 350]] },
      { points: [[180, 200], [180, 150], [180, 350]] },
      { cancel: true }, { multi: true }, { selector: '#replay-slider' }, { selector: '#live-button' },
    ];
    for (const attempt of rejected) await gesture(page, attempt);
    await page.mouse.move(180, 200);
    await page.mouse.down();
    await page.mouse.move(180, 340, { steps: 5 });
    await page.mouse.up();
    await page.evaluate(async () => {
      const { playerChrome } = await import('/static/player.js');
      return (playerChrome.options(true));
    });
    await gesture(page);
    await gesture(page, { selector: '#player-options' });
    await page.evaluate(async () => {
      const { playerChrome } = await import('/static/player.js');
      return (playerChrome.options(false));
    });
    assert.equal(documents, 0, 'Taps, short/reversed/horizontal/upward pulls, multitouch, cancellation, scrubbing, menu scrolling and mouse drags must not reload.');
    assert.equal(await page.locator('#pull-refresh').isVisible(), false);
    await page.evaluate(async () => {
      const { pageReplay } = await import('/static/player.js');

      history.replaceState({ unrelated: { keep: 42 }, testAutoplayMode: 'abort-once' }, '');
      localStorage.setItem('printer-camera', 'outdated-camera-preference');
      pageReplay.togglePause();
    });
    assert.equal(await page.locator('video').evaluate(video => video.paused), true);
    const historyLength = await page.evaluate(() => history.length);
    let cue;
    if (name === 'chromium') {
      const input = await context.newCDPSession(page);
      await input.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 180, y: 200 }] });
      for (const y of [215, 235, 260, 290, 315]) {
        await input.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 180, y }] });
      }
      assert.equal(documents, 0, 'An armed gesture must wait for release.');
      assert.equal(await page.locator('#pull-refresh-label').textContent(), 'Release to reload');
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
        input.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }),
      ]);
      await input.detach();
    } else {
      const result = await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), gesture(page)]);
      cue = result[1];
      assert.deepEqual(cue, { visible: true, label: 'Release to reload' });
    }
    await playing(page);
    const restored = await page.evaluate(async () => {
      const { pageReplay, selectedCamera } = await import('/static/player.js');
      return (({ startup: window.stateAtStartup, state: history.state,
      camera: selectedCamera, historyLength: history.length, session: pageReplay.session.session_id,
      autoplay: window.reloadPlayCalls, followLive: pageReplay.followLive }));
    });
    assert.equal(documents, 1, 'One pull must cause exactly one full document reload.');
    assert.equal(restored.historyLength, historyLength, 'Reload must not add a history entry.');
    assert.equal(restored.startup[key].cameraId, camera);
    assert.equal(restored.startup[key].autoplay, true);
    assert.equal(restored.startup[key].reason, 'pull-to-refresh');
    assert.equal(restored.camera, camera, 'The reload state must override an outdated local preference.');
    assert.deepEqual(restored.state, { unrelated: { keep: 42 }, testAutoplayMode: 'abort-once' });
    assert.notEqual(restored.session, firstSession, 'Full reload must start fresh page history.');
    assert.equal(restored.followLive, true);
    assert(restored.autoplay.length >= 2, 'Media readiness must retry an interrupted initial autoplay.');
    assert(restored.autoplay.every(call => call.muted && call.inline), 'Reload autoplay must remain muted and inline.');
    assert.equal(await page.locator('#pull-refresh').isVisible(), false);
    await page.reload();
    await playing(page);
    assert.equal(await page.evaluate(() => window.stateAtStartup?.printerCameraReload ?? null), null,
      'A later ordinary reload must not replay consumed metadata.');
    await page.evaluate(() => history.replaceState({ ...history.state, testAutoplayMode: 'blocked' }, ''));
    await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), gesture(page)]);
    await page.locator('#play-button').waitFor({ state: 'visible', timeout: 45000 });
    assert.equal(await page.locator('video').evaluate(video => video.paused), true);
    assert.equal(await page.evaluate(async () => {
      const { reloadAutoplay } = await import('/static/player.js');
      return (reloadAutoplay);
    }), false, 'Permission denial must stop automatic play retries.');
    await page.evaluate(() => { window.allowUserPlayback = true; });
    await page.locator('#play-button').click();
    await playing(page);
    assert.deepEqual(errors, []);
    await page.goto('about:blank');
    console.log(`${name}: rejected accidental gestures, ${name === 'chromium' ? 'trusted mobile swipe, ' : ''}full reload, single-use history state, camera restore, fresh buffer, muted inline autoplay/readiness retry, ordinary reload, and tap fallback passed`);
  } catch (error) {
    console.error(name, await page.evaluate(async () => {
      const { playerPullRefresh } = await import('/static/player.js');
      return (({ state: history.state, startup: window.stateAtStartup,
      refresh: typeof playerPullRefresh !== 'undefined' ? { pulling: playerPullRefresh.pulling, distance: playerPullRefresh.distance, refreshing: playerPullRefresh.refreshing } : null,
      paused: document.querySelector('video')?.paused, ready: document.querySelector('video')?.readyState,
      overlay: document.querySelector('#overlay-title')?.textContent, playCalls: window.reloadPlayCalls }));
    }).catch(() => null));
    throw error;
  } finally { await browser.close(); }
}

Promise.all([run('chromium', chromium), run('webkit', webkit)]).catch(error => { console.error(error); process.exitCode = 1; });
