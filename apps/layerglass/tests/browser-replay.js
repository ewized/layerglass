import { waitForPlayer } from './player-page.js';
import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';

const base = process.env.VIEWER_URL || 'http://127.0.0.1:8080';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(predicate, message, timeout = 45000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await delay(250); }
  throw new Error(message);
}

async function run(name, engine) {
  const browser = await engine.launch({ headless: true, args: name.startsWith('chromium') ? ['--no-sandbox'] : [] });
  let debugPage;
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    if (name === 'chromium-hls') await context.addInitScript(() => {
      const original = HTMLMediaElement.prototype.canPlayType;
      HTMLMediaElement.prototype.canPlayType = function(type) {
        return type.includes('mpegurl') ? '' : original.call(this, type);
      };
    });
    const page = await context.newPage();
    debugPage = page;
    const failures = [];
    const tokens = [];
    page.on('pageerror', error => failures.push(error.message));
    page.on('response', async response => {
      if (new URL(response.url()).pathname === '/api/sessions' && response.request().method() === 'POST' && response.ok()) {
        tokens.push((await response.json()).session_id);
      }
    });
    await page.goto(base);
    await page.waitForFunction(() => {
      const v = document.querySelector('video');
      return v.videoWidth > 0 && v.currentTime > 0 && !v.paused && document.querySelector('#overlay').hidden;
    }, undefined, { timeout: 45000 });
    await page.locator('#replay-controls').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#replay-time').evaluate(node => node.hidden), true, 'Live playback must not show a timer.');
    assert.equal(await page.locator('#replay-slider').getAttribute('aria-valuetext'), 'Live');
    await page.evaluate(async () => {
      const slider = document.querySelector('#replay-slider');
      for (let sample = 0; sample < 30; sample++) {
        if (Math.abs(Number(slider.value) - Number(slider.max)) > 1e-7) throw new Error('The live playhead must stay at the right edge as footage arrives.');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    });
    const token = tokens.at(-1);
    assert(token, 'The page needs its own replay session.');
    const metadata = async key => (await page.request.get(`${base}/api/sessions/${key}`)).json();
    const initial = await metadata(token);
    const manifest = await (await page.request.get(`${base}/replay/${token}/live.m3u8`)).text();
    const firstSegment = manifest.split('\n').find(line => line.endsWith('.ts'));
    await page.mouse.move(12, 12);
    await page.getByRole('button', { name: 'Pause video', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('video').paused);
    // Native decoders can finish their current frame just after paused flips.
    // Sample the timeline after that final frame and the next render tick.
    await page.waitForTimeout(300);
    const pausedAt = await page.locator('video').evaluate(v => v.currentTime);
    const timeline = () => page.locator('#replay-slider').evaluate(input => ({ min: input.min, max: input.max, value: input.value }));
    const pausedTimeline = await timeline();
    await until(async () => (await metadata(token)).end_seconds >= initial.end_seconds + 22,
      'Live footage must keep accumulating while paused.');
    assert.equal(tokens.length, 1, 'The stall watchdog must not reconnect a paused viewer.');
    assert(Math.abs(await page.locator('video').evaluate(v => v.currentTime) - pausedAt) < 0.5, 'Paused video moved.');
    assert.deepEqual(await timeline(), pausedTimeline, 'New footage must not rescale the timeline or move its paused playhead.');
    assert.equal(await page.locator('#replay-time').evaluate(node => node.hidden), false);
    const offset = await page.locator('#replay-time').textContent();
    assert.match(offset, /^−\d+:\d{2}(?::\d{2})?$/, 'Past playback must show only a negative offset from live.');
    const offsetSeconds = offset.slice(1).split(':').reduce((seconds, part) => seconds * 60 + Number(part), 0);
    assert(offsetSeconds >= 18, 'The offset must keep increasing while paused, including when the native seek range stops updating.');
    assert.equal(await page.locator('#replay-slider').getAttribute('aria-valuetext'), `${offset} from live`);
    assert.equal((await page.request.get(`${base}/replay/${token}/${firstSegment}`)).status(), 200,
      'Earliest footage must survive past the relay’s rolling window.');
    const sliderBox = await page.locator('#replay-slider').boundingBox();
    await page.mouse.move(sliderBox.x + sliderBox.width * 0.4, sliderBox.y + sliderBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(sliderBox.x + sliderBox.width * 0.3, sliderBox.y + sliderBox.height / 2);
    const draggingTimeline = await timeline();
    const draggingEnd = (await metadata(token)).end_seconds;
    await until(async () => (await metadata(token)).end_seconds >= draggingEnd + 4,
      'New footage must arrive during a held scrub gesture.');
    assert.deepEqual(await timeline(), draggingTimeline, 'Growing history must not move the scrubber underneath a held pointer.');
    await page.mouse.up();
    await page.locator('#replay-slider').evaluate(input => {
      input.value = Number(input.min) + 0.25;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForFunction(() => document.querySelector('video').currentTime < 2);
    assert.equal(await page.locator('#replay-time').evaluate(node => node.hidden), false);
    assert.equal(await page.locator('video').evaluate(v => v.paused), true, 'Scrubbing should respect pause.');
    const replayStart = await page.locator('#replay-slider').evaluate(input => {
      input.value = Number(input.min) + (Number(input.max) - Number(input.min)) / 2;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return Number(input.value);
    });
    await page.getByRole('button', { name: 'Play buffered video', exact: true }).click();
    await page.waitForFunction(start => document.querySelector('video').currentTime > start + 1.5 &&
      !document.querySelector('video').paused && document.querySelector('#overlay').hidden,
    replayStart, { timeout: 15000 });
    const motion = await page.evaluate(async () => {
      const { pageReplay } = await import('/static/player.js');

      const slider = document.querySelector('#replay-slider');
      const video = document.querySelector('video');
      const samples = [];
      const firstTime = video.currentTime;
      const firstEnd = pageReplay.session.end_seconds;
      for (let sample = 0; sample < 32; sample++) {
        samples.push((Number(slider.value) - Number(slider.min)) / (Number(slider.max) - Number(slider.min)));
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      return { min: Math.min(...samples), max: Math.max(...samples), drift: Math.max(...samples) - Math.min(...samples), played: video.currentTime - firstTime,
        captured: pageReplay.session.end_seconds - firstEnd };
    });
    assert(motion.played >= 6 && motion.captured >= 6, 'Replay and recording must both continue during the movement check.');
    assert(motion.min > 0.1 && motion.max < 0.9, 'The movement check must use the middle of the bar, away from clamped edges.');
    assert(motion.drift < 0.02, `Normal replay must stay in the same relative position as Live advances; drift was ${motion.drift}.`);
    await page.mouse.move(12, 12);
    await page.getByRole('button', { name: 'Return to live video', exact: true }).click();
    await page.waitForFunction(() => {
      const v = document.querySelector('video');
      return !v.paused && Number(document.querySelector('#replay-slider').max) - v.currentTime < 7;
    }, undefined, { timeout: 15000 });
    assert.equal(await page.locator('#caption-label').textContent(), 'LIVE VIEW');
    assert.equal(await page.locator('#replay-time').evaluate(node => node.hidden), true, 'Returning to live must hide the timer.');
    const liveTimeline = await timeline();
    assert(Math.abs(Number(liveTimeline.value) - Number(liveTimeline.max)) < 1e-7, 'Return to Live must pin the playhead to the latest edge.');
    const beforeRefresh = (await metadata(token)).end_seconds;
    await page.mouse.move(12, 12);
    await page.locator('#options-button').click();
    await page.getByRole('button', { name: 'Refresh viewer', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#overlay').hidden, undefined, { timeout: 20000 });
    assert.equal(tokens.length, 1, 'Refresh viewer must retain this page’s history.');
    assert((await metadata(token)).end_seconds >= beforeRefresh);

    const second = await context.newPage();
    let secondToken;
    second.on('response', async response => {
      if (new URL(response.url()).pathname === '/api/sessions' && response.ok()) secondToken = (await response.json()).session_id;
    });
    await second.goto(base);
    await second.waitForFunction(() => document.querySelector('#replay-controls') && !document.querySelector('#replay-controls').hidden);
    await until(() => secondToken, 'A second tab must create a new session.');
    assert.notEqual(secondToken, token);
    assert((await metadata(secondToken)).end_seconds < 8, 'A new tab must not inherit earlier footage.');
    assert.equal((await page.request.get(`${base}/replay/${secondToken}/${firstSegment}`)).status(), 404,
      'A new tab must not access an older tab’s buffered segment.');
    await second.goto('about:blank');

    await page.bringToFront();
    await page.reload();
    await until(() => tokens.length === 2, 'Reload should create a fresh buffer.');
    const fresh = tokens.at(-1);
    assert.notEqual(fresh, token);
    assert((await metadata(fresh)).end_seconds < 8);
    await until(async () => (await page.request.get(`${base}/api/sessions/${token}`)).status() === 404,
      'Reload should release the previous page’s buffer.');
    await page.waitForFunction(() => document.querySelector('#overlay').hidden, undefined, { timeout: 20000 });
    for (const viewport of [{ width: 320, height: 568 }, { width: 844, height: 390 }, { width: 390, height: 844 }]) {
      await page.evaluate(async () => {
      const { playerFullscreen } = await import('/static/player.js');
      return (playerFullscreen.exit());
    });
      await waitForPlayer(page, ({ app }) => {
      const { playerFullscreen } = app;
      return (!playerFullscreen.active() && !playerFullscreen.entering);
    });
      await page.setViewportSize(viewport);
      await waitForPlayer(page, ({ app }) => {
      const { playerFullscreen } = app;
      return (!playerFullscreen.entering);
    });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }
    assert.deepEqual(failures, []);
    if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/scrubbing-${name}.png`, fullPage: true });
    await page.goto('about:blank');
    await until(async () => (await context.request.get(`${base}/api/sessions/${fresh}`)).status() === 404,
      'Leaving the page should release its buffer.');
    console.log(`${name}: steady 1× replay (${(motion.drift * 100).toFixed(2)}% drift), stable live/paused/dragging timeline, capture, rewind, Live, refresh, tabs, reload, cleanup and mobile layout passed`);
  } catch (error) {
    if (debugPage && !debugPage.isClosed()) {
      console.error(name, error, await debugPage.evaluate(async () => {
      const { hls, pageReplay } = await import('/static/player.js');

        const v = document.querySelector('video');
        return { time: v.currentTime, paused: v.paused, ready: v.readyState, source: v.currentSrc,
          seekable: Array.from({ length: v.seekable.length }, (_, i) => [v.seekable.start(i), v.seekable.end(i)]),
          buffered: Array.from({ length: v.buffered.length }, (_, i) => [v.buffered.start(i), v.buffered.end(i)]),
          livePosition: typeof hls !== 'undefined' ? hls?.liveSyncPosition : null,
          slider: { min: pageReplay.slider.min, max: pageReplay.slider.max, value: pageReplay.slider.value,
            scrubbing: pageReplay.scrubbing, position: pageReplay.position },
          session: typeof pageReplay !== 'undefined' ? pageReplay.session : null };
      }));
    }
    throw error;
  } finally { await browser.close(); }
}

const runs = process.env.BROWSER === 'chromium' ? [run('chromium', chromium)] :
  [run('chromium', chromium), run('chromium-hls', chromium), run('webkit', webkit)];
Promise.allSettled(runs).then(results => {
  for (const result of results) if (result.status === 'rejected') {
    console.error(result.reason);
    process.exitCode = 1;
  }
});
