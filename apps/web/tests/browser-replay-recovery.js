import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { waitForPlayer } from './player-page.js';

const base = process.env.VIEWER_URL || 'http://127.0.0.1:8080';

for (const [name, engine] of Object.entries({ chromium, webkit })) {
  if (process.env.BROWSER && process.env.BROWSER !== name) continue;
  const browser = await engine.launch({ headless: true, args: name === 'chromium' ? ['--no-sandbox'] : [] });
  const viewer = `replay-${name}`;
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block',
    extraHTTPHeaders: { 'X-Fixture-Stream-Viewer': viewer } });
  // Optional vendor SDKs are irrelevant to recovery and must not leave the fixture.
  await context.route(url => ['http:', 'https:'].includes(url.protocol) && url.origin !== new URL(base).origin, route => route.abort());
  const block = async enabled => {
    const response = await context.request.post(`${base}/__fixture/video-stream?viewer=${viewer}&blocked=${enabled ? 1 : 0}`);
    assert.equal(response.status(), 200, 'Run against the generated camera fixture.');
  };
  const page = await context.newPage();
  const errors = [], messages = [], sessions = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (['warning', 'error'].includes(message.type())) messages.push(message.text()); });
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/sessions') sessions.push(request.url());
  });
  const read = () => page.evaluate(async () => {
    const app = await import('/static/player.js');
    const { printerPlaybackTime } = await import('/static/printer-history.js');
    const printerTime = printerPlaybackTime(app.video, app.hls, app.pageReplay);
    const slider = document.querySelector('#replay-slider');
    return { at: performance.now() / 1000, time: app.video.currentTime, paused: app.video.paused,
      followLive: app.pageReplay.followLive, session: app.pageReplay.session?.session_id,
      sameVideo: app.video === window.originalVideo, videos: document.querySelectorAll('video').length,
      rebuilt: app.hls !== window.priorHls, fallback: app.streamFallback, seeks: window.recoverySeeks,
      loadingPositions: window.loadingPositions,
      ready: app.video.readyState, attaching: app.pageReplay.attaching, restore: app.pageReplay.mediaRestore,
      hlsStart: app.hls?.startPosition, loading: app.hls?.loadingEnabled, mediaError: app.video.error?.message,
      buffered: Array.from({ length: app.video.buffered.length }, (_, i) => [app.video.buffered.start(i), app.video.buffered.end(i)]),
      stream: app.videoStream && { cache: [...app.videoStream.cache.keys()], requested: app.videoStream.requested, next: app.videoStream.nextSequence },
      printerTime, layer: app.printerHistory.peek(printerTime)?.layer,
      offset: app.pageReplay.session.end_seconds - app.video.currentTime,
      fraction: (Number(slider.value) - Number(slider.min)) / (Number(slider.max) - Number(slider.min)) };
  });
  const fatal = () => page.evaluate(async () => {
    const app = await import('/static/player.js');
    const { default: Hls } = await import('/static/vendor/hls.min.mjs');
    app.hls.trigger(Hls.Events.ERROR, { type: Hls.ErrorTypes.MEDIA_ERROR,
      details: Hls.ErrorDetails.BUFFER_APPEND_ERROR, fatal: true, error: new Error('Fixture decoder failure') });
  });
  try {
    await block(false);
    await page.goto(base);
    await waitForPlayer(page, ({ app }) => app.videoStream?.connected && app.video.readyState >= 3 &&
      !app.video.paused && app.pageReplay.session?.end_seconds - app.pageReplay.session?.start_seconds >= 16,
    null, { timeout: 45000 });
    await page.evaluate(async () => {
      const app = await import('/static/player.js');
      window.originalVideo = app.video;
      window.recoverySeeks = 0;
      window.loadingPositions = [];
      app.video.addEventListener('seeking', () => window.recoverySeeks++);
      app.video.addEventListener('emptied', () => window.loadingPositions.push(app.pageReplay.bounds().current));
    });
    const initial = await read();
    assert.equal(initial.followLive, true, 'A new session initially follows Live.');
    for (const [transport, paused, failure] of [
      ['stream', true, 'decoder'], ['stream', false, 'decoder'],
      ['hls', true, 'transport'], ['hls', false, 'decoder'], ['hls', true, 'decoder'],
    ]) {
      const target = await page.evaluate(async () => {
        const app = await import('/static/player.js');
        const { start, end } = app.pageReplay.bounds();
        const target = Math.max(start + 0.5, end - 12);
        app.pageReplay.seek(target);
        if (app.video.paused) app.pageReplay.togglePause();
        return target;
      });
      await waitForPlayer(page, ({ app, arg }) => !app.video.seeking && app.video.readyState >= 2 && !app.video.paused &&
        !app.pageReplay.followLive && app.video.currentTime >= arg && app.video.currentTime < arg + 3,
      target, { timeout: 20000 });
      if (paused) await page.evaluate(async () => (await import('/static/player.js')).pageReplay.togglePause());
      await page.evaluate(async () => {
        window.priorHls = (await import('/static/player.js')).hls;
        window.recoverySeeks = 0;
        window.loadingPositions = [];
      });
      const before = await read();
      assert.equal(before.paused, paused);
      assert(before.offset >= 9);
      if (failure === 'transport') {
        await block(true);
        await page.evaluate(async () => (await import('/static/player.js')).videoStream.controller.abort());
      } else await fatal();
      await waitForPlayer(page, ({ app, arg }) => app.hls !== window.priorHls && app.video.readyState >= 2 &&
        !app.video.seeking && !app.pageReplay.attaching && app.streamFallback === (arg === 'hls') &&
        (arg === 'hls' || app.videoStream?.connected), transport, { timeout: 25000 });
      const after = await read();
      assert.equal(after.session, initial.session);
      assert.equal(after.sameVideo, true);
      assert.equal(after.videos, 1);
      assert.equal(after.rebuilt, true);
      assert.equal(after.paused, paused, `${name}/${transport}: recovery preserves the pause intent`);
      assert.equal(after.followLive, false, `${name}/${transport}: recovery stays in replay`);
      assert(after.seeks <= 1, `${name}/${transport}: one restoration seek, observed ${after.seeks}`);
      assert(after.loadingPositions.every(position => position >= before.time - 0.1), 'Loading must not reset the displayed replay clock to zero.');
      if (paused) {
        assert(Math.abs(after.time - before.time) < 0.1, 'The decoded paused frame must keep its selected media time.');
        assert(Math.abs(after.printerTime - before.printerTime) < 0.1, 'The paused recorded telemetry clock must stay fixed.');
        assert.equal(after.layer, before.layer);
      } else {
        assert(after.time >= before.time - 0.1 && after.time <= before.time + after.at - before.at + 1,
          'Playing replay resumes its selected footage rather than jumping to Live.');
        assert(after.offset >= before.offset - 2);
      }
      await page.waitForTimeout(1400);
      const later = await read();
      if (paused) assert(Math.abs(later.time - after.time) < 0.1);
      else {
        assert(later.time > after.time + 0.7, 'Real decoded replay must continue progressing.');
        assert(Math.abs(later.fraction - after.fraction) < 0.02, 'Matched-rate replay retains a stable timeline fraction.');
      }
      console.log(JSON.stringify({ browser: name, transport, failure, paused,
        before: before.time, restored: after.time, offset: after.offset, seeks: after.seeks, sessionPreserved: true }));
    }
    // Hold only the finite fallback playlist, leaving decoder/media time real.
    // Explicit Live during attachment must supersede its saved replay position.
    const oldSource = await page.evaluate(async () => (await import('/static/player.js')).hls.url);
    await page.route('**/live.m3u8*', async route => {
      if (route.request().url() !== oldSource) await new Promise(resolve => setTimeout(resolve, 800));
      await route.continue();
    });
    await page.evaluate(async () => { window.priorHls = (await import('/static/player.js')).hls; });
    await fatal();
    await waitForPlayer(page, ({ app }) => app.hls !== window.priorHls && app.pageReplay.attaching, null, { timeout: 10000 });
    await page.evaluate(async () => (await import('/static/player.js')).pageReplay.goLive());
    await waitForPlayer(page, ({ app }) => app.video.readyState >= 2 && !app.video.seeking && !app.video.paused &&
      app.pageReplay.followLive && !app.pageReplay.attaching && app.pageReplay.bounds().end - app.video.currentTime < 8,
    null, { timeout: 25000 });
    assert.equal((await read()).session, initial.session);
    assert.equal(sessions.length, 1, 'All rebuilds must reuse the same page recording.');
    await page.unroute('**/live.m3u8*');
    // The bundled generated clip exercises the real native metadata/seek path
    // as well, without claiming older Safari's native network HLS is covered.
    await page.goto(`${base}/?backend=demo`);
    await waitForPlayer(page, ({ app }) => app.pageReplay.session?.kind === 'file' && app.video.readyState >= 2 &&
      app.video.currentTime > 175 && !app.video.paused, null, { timeout: 25000 });
    await page.evaluate(async () => {
      const app = await import('/static/player.js');
      window.originalVideo = app.video;
      window.restoreLoads = 0;
      app.video.addEventListener('loadeddata', () => window.restoreLoads++);
      app.video.addEventListener('seeking', () => window.recoverySeeks++);
    });
    for (const paused of [true, false]) {
      await page.evaluate(async () => {
        const app = await import('/static/player.js');
        app.pageReplay.seek(30);
        if (app.video.paused) app.pageReplay.togglePause();
      });
      await waitForPlayer(page, ({ app }) => !app.video.seeking && app.video.currentTime >= 30 && app.video.currentTime < 33 && !app.video.paused);
      if (paused) await page.evaluate(async () => (await import('/static/player.js')).pageReplay.togglePause());
      await page.evaluate(() => { window.recoverySeeks = 0; window.restoreLoads = 0; });
      const before = await read();
      await page.evaluate(async () => (await import('/static/player.js')).video.dispatchEvent(new Event('error')));
      await waitForPlayer(page, ({ app }) => window.restoreLoads > 0 && !app.pageReplay.attaching && !app.video.seeking &&
        app.video.readyState >= 2, null, { timeout: 15000 });
      const after = await read();
      assert.equal(after.session, before.session);
      assert.equal(after.sameVideo, true);
      assert.equal(after.videos, 1);
      assert.equal(after.paused, paused);
      assert.equal(after.followLive, false);
      assert.equal(after.seeks, 1, 'Native metadata restoration commits one seek.');
      if (paused) {
        assert(Math.abs(after.time - before.time) < 0.1);
        assert(Math.abs(after.printerTime - before.printerTime) < 0.1);
      } else assert(after.time >= before.time && after.time <= before.time + after.at - before.at + 1);
      await page.waitForTimeout(1200);
      const later = await read();
      if (paused) assert(Math.abs(later.time - after.time) < 0.1);
      else assert(later.time > after.time + 0.6);
      console.log(JSON.stringify({ browser: name, transport: 'native-file', paused,
        before: before.time, restored: after.time, seeks: after.seeks, sessionPreserved: true }));
    }
    assert.deepEqual(errors, []);
    console.log(`${name}: paused/playing continuous, HLS and native-file recovery, recorded clocks, one seek/session/video and explicit Live passed.`);
  } catch (error) {
    console.error(name, error.stack, await read().catch(() => null), messages.slice(-15));
    throw error;
  } finally {
    await page.goto('about:blank').catch(() => {});
    await block(false).catch(() => {});
    await browser.close();
  }
}
