import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { waitForPlayer } from './player-page.js';

const base = process.env.VIEWER_URL || 'http://127.0.0.1:8080';
const only = process.env.BROWSER;

for (const [name, engine] of Object.entries({ chromium, webkit })) {
  if (only && only !== name) continue;
  const browser = await engine.launch({ headless: true, args: name === 'chromium' ? ['--no-sandbox'] : [] });
  // WebKit's driver only supports real wheel events in desktop contexts.
  // Keep the phone-sized layout and exercise its touch pointer path below.
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: name === 'chromium', hasTouch: true });
  const page = await context.newPage();
  const requests = [];
  const errors = [];
  page.on('request', request => requests.push(new URL(request.url())));
  page.on('pageerror', error => errors.push(error.message));
  const videoRequests = () => requests.filter(url => /\/replay\/[^/]+\/video$/.test(url.pathname));
  const state = () => page.evaluate(async () => {
    const app = await import('/static/player.js');
    return { current: app.video.currentTime, paused: app.video.paused, scrubbing: app.pageReplay.scrubbing,
      target: app.pageReplay.previewPosition, token: app.pageReplay.session.session_id, commits: window.scrubCommits,
      seeks: window.scrubSeeks, live: app.pageReplay.followLive };
  });
  try {
    await page.goto(base);
    await waitForPlayer(page, ({ app }) => app.videoStream?.connected && app.video.currentTime > 1 &&
      app.pageReplay.session?.end_seconds >= 18, undefined, { timeout: 60000 });
    // Force an actual archive fetch after commit rather than relying on an
    // old frame that happens to remain in the browser's media/transport caches.
    await page.evaluate(async () => {
      const app = await import('/static/player.js');
      window.scrubOriginalBuffering = { maxSegments: app.videoStream.maxSegments, backBufferLength: app.hls.config.backBufferLength };
      app.videoStream.maxSegments = 2;
      app.hls.config.backBufferLength = 1;
    });
    await waitForPlayer(page, ({ app }) => app.videoStream.cache.size <= 2 &&
      app.video.buffered.length && app.video.buffered.start(0) > 4, undefined, { timeout: 20000 });
    await page.mouse.move(8, 8);
    await page.getByRole('button', { name: 'Pause video', exact: true }).click();
    await page.waitForTimeout(400);
    await page.evaluate(() => {
      window.scrubCommits = 0;
      window.scrubSeeks = 0;
      window.addEventListener('replaypositionchange', () => window.scrubCommits++);
      document.querySelector('video').addEventListener('seeking', () => window.scrubSeeks++);
    });
    await page.evaluate(async () => {
      const app = await import('/static/player.js');
      const connect = app.videoStream.connect;
      window.scrubStreamOpens = [];
      app.videoStream.connect = function(start) {
        window.scrubStreamOpens.push({ start, at: performance.now(), commits: window.scrubCommits,
          gesture: app.pageReplay.scrubType, current: app.video.currentTime });
        return connect.call(this, start);
      };
    });
    const original = await state();
    const slider = page.locator('#replay-slider');
    const box = await slider.boundingBox();
    const move = fraction => page.mouse.move(box.x + 8 + (box.width - 16) * fraction, box.y + box.height / 2);
    const previewLoaded = () => page.waitForFunction(() => {
      const p = document.querySelector('#scrub-preview');
      return !p.hidden && p.painted && Math.abs(p.displayed.time - p.point.time) <= 5;
    }, undefined, { timeout: 15000 });
    requests.length = 0;
    await move(0.7);
    await page.mouse.down();
    for (const fraction of [0.1, 0.8, 0.2, 0.9, 0.4, 0.6, 0.15, 0.03]) await move(fraction);
    await previewLoaded();
    await page.waitForTimeout(700);
    const during = await state();
    assert(Math.abs(during.current - original.current) < 0.1, 'Dragging must leave the actual video untouched.');
    assert.equal(during.commits, 0);
    assert.equal(during.seeks, 0);
    assert.equal(videoRequests().length, 0, 'No video?start request may be made while dragging.');
    assert.equal(during.scrubbing, true);
    assert(during.target < 2);
    await page.mouse.up();
    await waitForPlayer(page, ({ app }) => !app.video.seeking && app.video.readyState >= 2 &&
      app.video.currentTime < 3 && !app.pageReplay.scrubbing, undefined, { timeout: 20000 });
    await page.waitForTimeout(500);
    assert.equal(videoRequests().length, 1, 'Releasing the scrubber must open one archived stream.');
    assert.equal((await state()).commits, 1, 'Native pointerup + change must commit once.');
    assert.equal((await state()).paused, true);
    await page.evaluate(async () => {
      const app = await import('/static/player.js');
      app.videoStream.maxSegments = window.scrubOriginalBuffering.maxSegments;
      app.hls.config.backBufferLength = window.scrubOriginalBuffering.backBufferLength;
    });

    // Escape must cancel the gesture even if the pointer continues moving.
    const beforeCancel = await state();
    requests.length = 0;
    await move(0.5);
    await page.mouse.down();
    await move(0.8);
    await page.keyboard.press('Escape');
    await move(0.4);
    await page.mouse.up();
    assert.equal((await state()).commits, beforeCancel.commits);
    assert(Math.abs((await state()).current - beforeCancel.current) < 0.1);
    assert.equal(videoRequests().length, 0);

    // Native keyboard auto-repeat emits change for every step on some engines.
    // None may reach the decoder until keyup.
    await slider.focus();
    const beforeKeys = await state();
    await page.keyboard.down('ArrowRight');
    for (let step = 0; step < 12; step++) await page.keyboard.down('ArrowRight');
    assert.equal((await state()).commits, beforeKeys.commits);
    assert(Math.abs((await state()).current - beforeKeys.current) < 0.1);
    await page.keyboard.up('ArrowRight');
    assert.equal((await state()).commits, beforeKeys.commits + 1);
    await waitForPlayer(page, ({ app }) => !app.video.seeking && app.video.readyState >= 2,
      undefined, { timeout: 20000 });
    await slider.evaluate(node => node.blur());

    // A decoded seek frame is ready before hls.js finishes its forward refill.
    // Drain that preceding keyboard seek before attributing HTTP requests to
    // the next gesture; its delayed archive fetch is not caused by scrolling.
    await waitForPlayer(page, ({ app }) => {
      const video = app.video;
      const target = Math.min(app.pageReplay.session.end_seconds - 2,
        video.currentTime + app.hls.config.maxBufferLength);
      const openedAt = window.scrubStreamOpens.at(-1)?.at ?? 0;
      return !video.seeking && video.readyState >= 2 && app.videoStream.connected &&
        performance.now() - openedAt >= 1500 &&
        Array.from({ length: video.buffered.length }, (_, i) => i).some(i =>
          video.buffered.start(i) <= video.currentTime && video.buffered.end(i) >= target);
    }, undefined, { timeout: 20000 });
    const beforeScroll = await state();
    requests.length = 0;
    await move(0.5);
    await page.mouse.wheel(-5, 0);
    await waitForPlayer(page, ({ app }) => app.pageReplay.scrubType === 'wheel');
    // Deliver the rest of the burst inside the page. WebKit's automation
    // round trips can exceed the idle interval between native wheel calls.
    await slider.evaluate(async (input, previous) => {
      for (let step = 0; step < 10; step++) {
        input.dispatchEvent(new WheelEvent('wheel', { deltaX: -5, bubbles: true, cancelable: true }));
        await new Promise(resolve => setTimeout(resolve, 45));
        if (window.scrubCommits !== previous) throw new Error('Scrolling committed before the wheel burst ended.');
      }
    }, beforeScroll.commits);
    assert.equal(videoRequests().length, 0, 'Scrolling must preview, without reopening video.');
    await page.waitForFunction(previous => window.scrubCommits === previous + 1, beforeScroll.commits);
    await waitForPlayer(page, ({ app }) => !app.video.seeking && app.video.readyState >= 2,
      undefined, { timeout: 20000 });
    assert(videoRequests().length <= 1, 'A settled wheel gesture may open at most one stream.');

    // A real mobile drag must also delay its only seek until touchend.
    const beforeTouch = await state();
    if (name === 'chromium') {
      const cdp = await context.newCDPSession(page);
      const touch = (type, fraction) => cdp.send('Input.dispatchTouchEvent', { type,
        touchPoints: fraction === undefined ? [] : [{ x: box.x + box.width * fraction, y: box.y + box.height / 2, id: 1 }] });
      await touch('touchStart', 0.6);
      for (const fraction of [0.7, 0.3, 0.8, 0.4]) await touch('touchMove', fraction);
      assert.equal((await state()).commits, beforeTouch.commits);
      assert(Math.abs((await state()).current - beforeTouch.current) < 0.1);
      await touch('touchEnd');
    } else {
      // The WebKit driver cannot drag touches; test its pointer/input path.
      await slider.dispatchEvent('pointerdown', { pointerType: 'touch', pointerId: 7, isPrimary: true, button: 0, clientX: box.x + box.width * 0.6 });
      await slider.evaluate(input => {
        for (const fraction of [0.7, 0.3, 0.8, 0.4]) {
          input.value = Number(input.max) * fraction;
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
      });
      assert.equal((await state()).commits, beforeTouch.commits);
      await slider.dispatchEvent('pointerup', { pointerType: 'touch', pointerId: 7 });
    }
    assert.equal((await state()).commits, beforeTouch.commits + 1);
    assert.equal((await state()).paused, true);
    assert.equal((await state()).token, original.token);

    await page.getByRole('button', { name: 'Return to live video', exact: true }).click();
    await page.waitForFunction(() => {
      const video = document.querySelector('video');
      return !video.paused && !video.seeking && video.readyState >= 2;
    });
    const playing = await state();
    await move(0.8);
    await page.mouse.down();
    await move(0.5);
    await page.waitForTimeout(800);
    const playingPreview = await state();
    assert.equal(playingPreview.paused, false);
    assert(playingPreview.current >= playing.current);
    assert.equal(playingPreview.commits, playing.commits);
    await page.mouse.up();
    assert.equal((await state()).paused, false, 'Playing scrubs must remain playing after release.');
    await page.screenshot({ path: `/app/test-results/scrub-commit/${process.env.SCREENSHOT_PREFIX || ''}${name}.png` });
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ browser: name, duringDragVideoRequests: 0, onReleaseVideoRequests: 1,
      previews: true, keyboardRepeat: true, scrollCoalescing: true, cancel: true, touch: true, preservePauseAndPlay: true }));
  } catch (error) {
    console.error(name, error.message, await state().catch(() => null));
    console.error('Stream opens', await page.evaluate(() => window.scrubStreamOpens).catch(() => null),
      'Requests', videoRequests().map(url => url.pathname + url.search));
    throw error;
  } finally { await browser.close(); }
}
