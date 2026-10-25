import { waitForPlayer } from './player-page.js';
import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
const base = process.env.VIEWER_URL || 'http://127.0.0.1:8080';
const mediaRequests = paths => paths.filter(path => /\/(?:live\.m3u8|segment-\d+\.ts|video)$/.test(path));

async function playing(page) {
  await page.waitForFunction(() => {
    const v = document.querySelector('video');
    return v.videoWidth > 0 && v.readyState >= 3 && !v.seeking && !v.paused && v.currentTime > 0 && document.querySelector('#overlay').hidden;
  }, undefined, { timeout: 45000 });
}

async function run(name, engine) {
  const browser = await engine.launch({ headless: true, args: name === 'chromium' ? ['--no-sandbox'] : [] });
  // Fault injection must reach page.route. In WebKit a controlling service
  // worker bypasses it, even with the development worker's fetch handler off.
  // Service-worker behavior is exercised separately by browser-pwa.js.
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  const page = await context.newPage();
  const requests = [];
  const errors = [];
  await page.addInitScript(() => {
    window.streamTestEvents = [];
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function(...args) {
      window.streamTestEvents.push({ type: 'play()', stack: new Error().stack, at: performance.now() });
      return play.apply(this, args);
    };
    for (const type of ['play', 'pause', 'loadedmetadata', 'canplay', 'emptied']) document.addEventListener(type, event => {
      if (event.target.tagName === 'VIDEO') window.streamTestEvents.push({ type, at: performance.now(),
        time: event.target.currentTime, paused: event.target.paused, ready: event.target.readyState });
    }, true);
  });
  page.on('request', request => requests.push(new URL(request.url()).pathname));
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(base);
    await playing(page);
    assert.equal(await page.evaluate(async () => {
      const { videoStream } = await import('/static/player.js');
      return (Boolean(videoStream?.connected));
    }), true);
    const session = await page.evaluate(async () => {
      const { pageReplay } = await import('/static/player.js');
      return (pageReplay.session.session_id);
    });
    const time = await page.locator('video').evaluate(v => v.currentTime);
    await page.evaluate(() => {
      window.nativeProgressFrames = document.querySelector('video').getVideoPlaybackQuality().totalVideoFrames;
      window.loadingWrites = 0;
      window.loadingObserver = new MutationObserver(records => { window.loadingWrites += records.length; });
      window.loadingObserver.observe(document.querySelector('#overlay'), { attributes: true });
    });
    requests.length = 0;
    // Headless WebKit's presentation counter is not a frame-rate benchmark.
    // Measure progress over the full window; CI scheduling may batch its frame
    // updates. Clock, media-request and overlay assertions remain independent.
    await page.waitForTimeout(20000);
    assert.deepEqual(mediaRequests(requests), [], 'Steady playback must not fetch playlists, segments or replacement streams.');
    assert(await page.locator('video').evaluate(v => v.currentTime) >= time + 17, 'Video must keep playing through the open response.');
    assert(await page.evaluate(() => document.querySelector('video').getVideoPlaybackQuality().totalVideoFrames > window.nativeProgressFrames),
      'Native video must present new frames during the open response.');
    assert.equal(await page.evaluate(() => { window.loadingObserver.disconnect(); return window.loadingWrites; }), 0,
      'Steady playback must not repeatedly write the already-hidden loading overlay.');
    assert.equal(requests.filter(path => path === '/api/status' || path === '/api/cameras').length, 0);
    await page.evaluate(async () => {
      const { hls, playerTools, videoStream } = await import('/static/player.js');

      playerTools.showStats(true);
      videoStream.maxSegments = 2;
      hls.config.backBufferLength = 1;
    });
    assert.equal(await page.locator('[data-stat="Video delivery"]').textContent(), 'HTTP stream');
    assert.equal(await page.locator('[data-stat="Decoder"]').textContent(), 'Browser native');
    assert.equal(await page.locator('[data-stat="Media pipeline"]').textContent(), 'hls.js + MediaSource');
    assert.match(await page.locator('[data-stat="Video codec"]').textContent(), /^avc1\./);
    await waitForPlayer(page, ({ app }) => {
      const { videoStream } = app;
      return (videoStream.cache.size <= 2 && document.querySelector('video').buffered.start(0) > 3);
    });
    requests.length = 0;
    await page.evaluate(async () => {
      const { pageReplay } = await import('/static/player.js');
      return (pageReplay.seek(0.5));
    });
    await page.waitForFunction(() => document.querySelector('video').currentTime > 1 && document.querySelector('video').currentTime < 5);
    await playing(page);
    assert.equal(await page.evaluate(async () => {
      const { pageReplay } = await import('/static/player.js');
      return (pageReplay.session.session_id);
    }), session);
    assert.equal(mediaRequests(requests).filter(path => path.endsWith('/video')).length, 1, 'An old seek repositions the continuous stream once.');
    assert.equal(mediaRequests(requests).filter(path => !path.endsWith('/video')).length, 0, 'Archived footage also uses the stream.');
    requests.length = 0;
    const replayTime = await page.locator('video').evaluate(v => v.currentTime);
    await page.waitForTimeout(8000);
    assert(await page.locator('video').evaluate(v => v.currentTime) > replayTime + 6, 'Paced archived video must keep playing.');
    assert.deepEqual(mediaRequests(requests), []);
    await page.evaluate(async () => {
      const { pageReplay } = await import('/static/player.js');
      return (pageReplay.goLive());
    });
    await playing(page);
    await waitForPlayer(page, ({ app }) => {
      const { pageReplay } = app;
      return (pageReplay.bounds().end - document.querySelector('video').currentTime < 7);
    });
    await playing(page);
    assert.equal(await page.evaluate(async () => {
      const { pageReplay } = await import('/static/player.js');
      return (pageReplay.session.session_id);
    }), session);
    await page.mouse.move(10, 10);
    await page.locator('#pause-button').click();
    const paused = await page.locator('video').evaluate(v => v.currentTime);
    const version = await page.evaluate(async () => {
      const { videoStream } = await import('/static/player.js');
      return (videoStream.version);
    });
    await page.evaluate(async () => {
      const { videoStream } = await import('/static/player.js');
      return (videoStream.controller.abort());
    });
    await waitForPlayer(page, ({ app, arg: version }) => {
      const { videoStream } = app;
      return (videoStream?.connected && videoStream.version > version);
    },
      version, { timeout: 15000 });
    assert.equal(await page.locator('video').evaluate(v => v.paused), true);
    assert(Math.abs(await page.locator('video').evaluate(v => v.currentTime) - paused) < 0.5, 'Transport recovery must preserve pause.');
    assert.equal(await page.evaluate(async () => {
      const { pageReplay } = await import('/static/player.js');
      return (pageReplay.session.session_id);
    }), session);
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { value: true, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    assert.equal(await page.evaluate(async () => {
      const { videoStream } = await import('/static/player.js');
      return (videoStream.controller);
    }), null);
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { value: false, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitForPlayer(page, ({ app }) => {
      const { videoStream } = app;
      return (videoStream?.connected);
    });
    assert.equal(await page.locator('video').evaluate(v => v.paused), true);
    assert.equal(await page.evaluate(async () => {
      const { pageReplay } = await import('/static/player.js');
      return (pageReplay.session.session_id);
    }), session);
    assert.deepEqual(errors, []);
    await page.goto('about:blank');

    // An intermediary that rejects streaming must still leave a usable player.
    const fallback = await context.newPage();
    const fallbackRequests = [];
    fallback.on('request', request => fallbackRequests.push(new URL(request.url()).pathname));
    await fallback.route('**/replay/*/video*', route => route.fulfill({ status: 503, body: 'Unavailable' }));
    await fallback.goto(base);
    await playing(fallback);
    // Decoding a frame alone does not establish that the connection retry
    // policy has completed; wait for the transport state explicitly.
    await waitForPlayer(fallback, ({ app }) => app.streamFallback && !app.videoStream,
      undefined, { timeout: 15000 });
    assert.equal(await fallback.evaluate(async () => {
      const { streamFallback, videoStream } = await import('/static/player.js');
      return (streamFallback && !videoStream);
    }), true);
    assert.equal(fallbackRequests.filter(path => path.endsWith('/video')).length, 3);
    assert(fallbackRequests.some(path => path.endsWith('.m3u8')));
    assert(fallbackRequests.some(path => path.endsWith('.ts')));
    await fallback.goto('about:blank');

    // Older phones without fetch response streams retain the native/HLS path.
    const legacy = await context.newPage();
    await legacy.addInitScript(() => { window.ReadableStream = undefined; });
    const legacyRequests = [];
    legacy.on('request', request => legacyRequests.push(new URL(request.url()).pathname));
    await legacy.goto(base);
    await playing(legacy);
    assert.equal(await legacy.evaluate(async () => {
      const { videoStream } = await import('/static/player.js');
      return (videoStream);
    }), null);
    assert.equal(legacyRequests.filter(path => path.endsWith('/video')).length, 0);
    assert(legacyRequests.some(path => path.endsWith('.m3u8')));
    await legacy.goto('about:blank');
    console.log(`${name}: 20 seconds with zero new media requests; streamed old rewind, Live, bounded cache, paused recovery, background resume, rejected-stream fallback and legacy HLS passed`);
  } catch (error) {
    console.error(name, error);
    if (!page.isClosed() && page.url() !== 'about:blank') console.error(await page.evaluate(async () => {
      const { pageReplay, streamFallback, video, videoStream } = await import('/static/player.js');
      return (({
      video: { time: video.currentTime, ready: video.readyState, paused: video.paused,
        initialFrames: window.nativeProgressFrames, frames: video.getVideoPlaybackQuality?.().totalVideoFrames,
        dropped: video.getVideoPlaybackQuality?.().droppedVideoFrames, hidden: document.hidden },
      stream: videoStream && { connected: videoStream.connected, next: videoStream.nextSequence,
        requested: videoStream.requested, count: videoStream.cache.size, bytes: videoStream.bytes, failures: videoStream.failures },
      history: pageReplay.session && { start: pageReplay.session.start_seconds, end: pageReplay.session.end_seconds },
      streamFallback
      , events: window.streamTestEvents?.slice(-25)
    }));
    }));
    throw error;
  } finally { await browser.close(); }
}

// Timed decoding checks share the fixture/runner CPU; isolate the engines.
for (const [name, engine] of Object.entries({ chromium, webkit })) {
  if (process.env.BROWSER && process.env.BROWSER !== name) continue;
  await run(name, engine);
}
