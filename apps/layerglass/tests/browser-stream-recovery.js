import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { waitForPlayer } from './player-page.js';

const base = process.env.VIEWER_URL || 'http://127.0.0.1:8080';
const media = path => /\/(?:live\.m3u8|segment-\d+\.ts|video)$/.test(path);

async function run(name, engine) {
  const browser = await engine.launch({ headless: true, args: name === 'chromium' ? ['--no-sandbox'] : [] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block',
    extraHTTPHeaders: { 'X-Fixture-Stream-Viewer': name } });
  await context.route(url => ['http:', 'https:'].includes(url.protocol) && url.origin !== new URL(base).origin, route => route.abort());
  const block = async enabled => {
    const response = await context.request.post(`${base}/__fixture/video-stream?viewer=${name}&blocked=${enabled ? 1 : 0}`);
    assert.equal(response.status(), 200, 'Run this test against tests/fixture_server.py.');
  };
  const page = await context.newPage();
  const requests = [];
  const errors = [];
  const messages = [];
  page.on('console', message => { if (['warning', 'error', 'info'].includes(message.type())) messages.push(message.text()); });
  page.on('request', request => { const path = new URL(request.url()).pathname; if (media(path)) requests.push(path); });
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(base);
    await waitForPlayer(page, ({ app }) => app.videoStream?.connected && app.video.videoWidth > 0 && !app.video.paused,
      undefined, { timeout: 30000 });
    const session = await page.evaluate(async () => (await import('/static/player.js')).pageReplay.session.session_id);
    const initial = await page.evaluateHandle(async () => (await import('/static/player.js')).hls);
    // A decoder failure does not establish that binary HTTP delivery is broken.
    await page.evaluate(async () => {
      const app = await import('/static/player.js');
      const { default: Hls } = await import('/static/vendor/hls.min.mjs');
      app.hls.trigger(Hls.Events.ERROR, { type: Hls.ErrorTypes.MEDIA_ERROR,
        details: Hls.ErrorDetails.BUFFER_APPEND_ERROR, fatal: true, error: new Error('Injected decoder failure') });
    });
    assert.equal(await page.evaluate(async () => (await import('/static/player.js')).streamFallback), false,
      'A fatal decoder error must not permanently enable playlist/segment polling.');
    await waitForPlayer(page, ({ app, arg }) => app.hls !== arg && app.videoStream?.connected && app.video.readyState >= 3 && !app.video.paused,
      initial, { timeout: 20000 });
    await initial.dispose();
    assert.equal(await page.evaluate(async () => (await import('/static/player.js')).pageReplay.session.session_id), session);
    assert.equal(requests.some(path => path.endsWith('.m3u8') || path.endsWith('.ts')), false);

    // A hidden tab must cancel hls.js deadlines, not mistake its deliberately
    // stopped HTTP reader for an unsupported streaming endpoint after 45 seconds.
    await page.mouse.move(10, 10);
    await page.locator('#pause-button').click();
    await page.waitForTimeout(300);
    const pausedAt = await page.locator('video').evaluate(video => video.currentTime);
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    assert.equal(await page.evaluate(async () => {
      const app = await import('/static/player.js');
      return app.loadingSuspended && !app.hls.loadingEnabled && !app.videoStream.controller;
    }), true);
    requests.length = 0;
    await page.waitForTimeout(47000);
    assert.deepEqual(requests, [], 'A background tab must not restart loading or switch to repeated HLS requests.');
    assert.equal(await page.evaluate(async () => (await import('/static/player.js')).streamFallback), false);
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: false });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitForPlayer(page, ({ app }) => app.videoStream?.connected && app.hls.loadingEnabled);
    assert.equal(await page.locator('video').evaluate(video => video.paused), true);
    assert(Math.abs(await page.locator('video').evaluate(video => video.currentTime) - pausedAt) < 0.5);
    assert.equal(await page.evaluate(async () => (await import('/static/player.js')).pageReplay.session.session_id), session);
    await page.goto('about:blank');

    // An actual endpoint rejection can still use HLS. Its recovery probe is
    // bounded and never tears down that working player until video data arrives.
    // Reject at the real test server; WebKit interception can buffer stream
    // bodies even after routing is disabled. Browser delivery stays unmodified.
    await block(true);
    await page.goto(base);
    await waitForPlayer(page, ({ app }) => app.streamFallback && !app.videoStream && app.video.readyState >= 3 && !app.video.paused,
      undefined, { timeout: 30000 });
    const fallbackSession = await page.evaluate(async () => (await import('/static/player.js')).pageReplay.session.session_id);
    assert.equal(await page.evaluate(async () => Boolean((await import('/static/player.js')).streamRetryTimer)), true);
    await page.evaluate(async () => {
      const app = await import('/static/player.js');
      window.fallbackHls = app.hls;
      window.retryDelays = [];
      const timeout = window.setTimeout;
      window.setTimeout = function(fn, delay, ...args) {
        if (delay >= 60000) window.retryDelays.push(delay);
        return timeout.call(this, fn, delay, ...args);
      };
      await app.retryContinuous();
      await app.retryContinuous();
    });
    assert.deepEqual(await page.evaluate(() => window.retryDelays), [120000, 240000]);
    assert.equal(await page.evaluate(async () => {
      const app = await import('/static/player.js');
      return app.hls === window.fallbackHls && app.streamFallback && !app.streamProbe && app.streamRetryAttempts === 2 && !app.video.paused;
    }), true, 'Rejected probes must preserve the active HLS decoder and back off.');
    await block(false);
    const beforeUpgrade = requests.filter(path => path.endsWith('/video')).length;
    await page.evaluate(async () => {
      const app = await import('/static/player.js');
      const recovery = app.retryContinuous();
      // SSE replaces the session metadata object while preserving its ID. A
      // slow probe must survive those ordinary in-flight metadata updates.
      app.pageReplay.updateMetadata(app.pageReplay.session.session_id, { ...app.pageReplay.session });
      await recovery;
    });
    await waitForPlayer(page, ({ app }) => !app.streamFallback && app.videoStream?.connected && app.hls !== window.fallbackHls &&
      app.video.readyState >= 3 && !app.video.paused, undefined, { timeout: 20000 });
    assert.equal(await page.evaluate(async () => {
      const app = await import('/static/player.js');
      return !app.streamProbe && !app.streamRetryTimer && app.videoStream.failureLimit === 3 && !app.videoStream.quiet;
    }), true);
    assert.equal(await page.evaluate(async () => (await import('/static/player.js')).pageReplay.session.session_id), fallbackSession);
    assert.equal(requests.filter(path => path.endsWith('/video')).length, beforeUpgrade + 1,
      'Upgrade must adopt the proven response instead of opening another video connection.');
    requests.length = 0;
    const before = await page.locator('video').evaluate(video => video.currentTime);
    await page.waitForTimeout(10000);
    assert.deepEqual(requests, [], 'Recovered streaming must stop all playlist and segment polling.');
    assert(await page.locator('video').evaluate(video => video.currentTime) > before + 7);
    await page.goto('about:blank');

    // Exercise the real scheduled callback too. Accelerate only its first 60s
    // cooldown, leaving network retries, decoder clocks and streaming untouched.
    await page.addInitScript(() => {
      const timeout = window.setTimeout;
      window.automaticProbeDelays = [];
      window.setTimeout = function(fn, delay, ...args) {
        if (delay === 60000) { window.automaticProbeDelays.push(delay); delay = 1500; }
        return timeout.call(this, fn, delay, ...args);
      };
    });
    await block(true);
    requests.length = 0;
    await page.goto(base);
    await waitForPlayer(page, ({ app }) => app.streamFallback && Boolean(app.streamRetryTimer),
      undefined, { timeout: 20000 });
    await block(false);
    await waitForPlayer(page, ({ app }) => !app.streamFallback && app.videoStream?.connected &&
      app.video.readyState >= 3 && !app.video.paused, undefined, { timeout: 20000 });
    assert.deepEqual(await page.evaluate(() => window.automaticProbeDelays), [60000]);
    assert.equal(requests.filter(path => path.endsWith('/video')).length, 4,
      'Three initial failures and one scheduled probe must restore streaming without a duplicate fetch.');
    await page.goto('about:blank');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ browser: name, decoderRecoveryKeepsStreaming: true, hiddenSeconds: 47,
      backgroundRequests: 0, pausedHistoryPreserved: true, fallbackProbeBackoff: true, failedProbeKeepsDecoder: true,
      continuousRestored: true, automaticRetry: true, recoveredPlaybackSeconds: 10, recurringMediaRequests: 0 }));
  } catch (error) {
    console.error(name, error.message);
    console.error(await page.evaluate(async () => {
      const app = await import('/static/player.js');
      return { fallback: app.streamFallback, probing: Boolean(app.streamProbe), attempts: app.streamRetryAttempts,
        suspended: app.loadingSuspended, loading: app.hls?.loadingEnabled, paused: app.video.paused,
        ready: app.video.readyState, time: app.video.currentTime, end: app.pageReplay.session?.end_seconds,
        mediaError: app.video.error?.message, stream: app.videoStream && { connected: app.videoStream.connected,
          cache: [...app.videoStream.cache.keys()], requested: app.videoStream.requested, next: app.videoStream.nextSequence } };
    }).catch(() => null));
    console.error(messages.slice(-15));
    throw error;
  } finally { await block(false).catch(() => {}); await browser.close(); }
}

for (const [name, engine] of Object.entries({ chromium, webkit })) {
  if (process.env.BROWSER && process.env.BROWSER !== name) continue;
  await run(name, engine);
}
