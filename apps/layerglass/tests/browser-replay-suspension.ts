import type * as BackendContractsTypes from '../../backend-contracts/src/index.js';
import type { Route } from 'playwright';
import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { waitForPlayer } from './player-page.ts';

const base = process.env.VIEWER_URL || 'http://127.0.0.1:8080';

for (const [name, engine] of Object.entries({ chromium, webkit })) {
  if (process.env.BROWSER && process.env.BROWSER !== name) continue;
  const browser = await engine.launch({ headless: true, args: name === 'chromium' ? ['--no-sandbox'] : [] });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    serviceWorkers: 'block',
  });
  await context.route(
    (url) => ['http:', 'https:'].includes(url.protocol) && url.origin !== new URL(base).origin,
    (route: Route) => route.abort(),
  );
  await context.addInitScript(() => {
    window.fixtureHidden = false;
    window.fixtureOnline = true;
    Object.defineProperty(document, 'hidden', { get: () => window.fixtureHidden });
    Object.defineProperty(navigator, 'onLine', { get: () => window.fixtureOnline });
  });
  const page = await context.newPage();
  const errors: Array<string> = [],
    messages: Array<string> = [],
    sessions: Array<string> = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (['warning', 'error'].includes(message.type())) messages.push(message.text());
  });
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/sessions')
      sessions.push(request.url());
  });
  const read = () =>
    page.evaluate(async () => {
      const app = await import('/static/player.js');
      const { printerPlaybackTime } = await import('/static/printer-history.js');
      return {
        at: performance.now() / 1000,
        time: app.video.currentTime,
        paused: app.video.paused,
        desiredPaused: app.pageReplay.paused,
        followLive: app.pageReplay.followLive,
        session: app.pageReplay.session?.session_id,
        camera: app.selectedCamera,
        sameVideo: app.video === window.originalVideo,
        videos: document.querySelectorAll<HTMLVideoElement>('video').length,
        sameTransport: app.videoStream === window.pendingTransport,
        hls: Boolean(app.hls),
        ready: app.video.readyState,
        attaching: app.pageReplay.attaching,
        restore: app.pageReplay.mediaRestore,
        fallback: app.streamFallback,
        seeks: window.recoverySeeks,
        decoders: window.decoderAttachments,
        deadlines: window.readinessDeadlines,
        printerTime: printerPlaybackTime(app.video, app.hls, app.pageReplay),
        offset: (app.pageReplay.session?.end_seconds ?? Number.NaN) - app.video.currentTime,
      };
    });
  const beginRecovery = async (paused: boolean) => {
    await waitForPlayer(
      page,
      ({ app }) =>
        (app.pageReplay.session?.end_seconds ?? Number.NaN) -
          (app.pageReplay.session?.start_seconds ?? Number.NaN) >=
        16,
      null,
      { timeout: 30000 },
    );
    const target = await page.evaluate(async () => {
      const app = await import('/static/player.js');
      const target = app.pageReplay.bounds().end - 12;
      app.pageReplay.seek(target);
      if (app.video.paused) app.pageReplay.togglePause();
      return target;
    });
    await waitForPlayer(
      page,
      ({ app, arg }) =>
        !app.video.seeking &&
        app.video.readyState >= 2 &&
        !app.video.paused &&
        app.video.currentTime >= arg &&
        app.video.currentTime < arg + 3,
      target,
      { timeout: 15000 },
    );
    if (paused) await page.evaluate(async () => (await import('/static/player.js')).pageReplay.togglePause());
    const before = await read();
    await page.evaluate(async () => {
      const app = await import('/static/player.js');
      const { default: Hls } = await import('/static/vendor/hls.min.mjs');
      window.previousTransport = app.videoStream;
      window.recoverySeeks = window.decoderAttachments = window.readinessDeadlines = 0;
      window.holdInitialMedia = true;
      app.hls!.trigger(Hls.Events.ERROR, {
        type: Hls.ErrorTypes.MEDIA_ERROR,
        details: Hls.ErrorDetails.BUFFER_APPEND_ERROR,
        fatal: true,
        error: new Error('Fixture decoder failure'),
      });
    });
    await waitForPlayer(
      page,
      ({ app }) =>
        !app.hls &&
        app.videoStream &&
        app.videoStream !== window.previousTransport &&
        app.videoStream!.nextSequence === null &&
        window.heldMedia.has(app.videoStream!) &&
        app.pageReplay.mediaRestore,
      null,
      { timeout: 10000 },
    );
    await page.evaluate(async () => {
      window.pendingTransport = (await import('/static/player.js')).videoStream;
    });
    return before;
  };
  const suspend = (kind: string, active: boolean) =>
    page.evaluate(
      ({ kind, active }) => {
        if (kind === 'hidden') {
          window.fixtureHidden = active;
          document.dispatchEvent(new Event('visibilitychange'));
        } else {
          window.fixtureOnline = !active;
          window.dispatchEvent(new Event(active ? 'offline' : 'online'));
        }
      },
      { kind, active },
    );
  const releaseMedia = () =>
    page.evaluate(() => {
      window.holdInitialMedia = false;
      for (const [transport, records] of window.heldMedia) {
        if (!transport.destroyed) for (const [header, data] of records) transport.accept(header, data);
      }
      window.heldMedia.clear();
    });
  let releaseSession: (() => void) | undefined;
  try {
    await page.goto(base);
    await waitForPlayer(
      page,
      ({ app }) =>
        app.videoStream?.connected &&
        app.video.readyState >= 3 &&
        !app.video.paused &&
        (app.pageReplay.session?.end_seconds ?? Number.NaN) -
          (app.pageReplay.session?.start_seconds ?? Number.NaN) >=
          16,
      null,
      { timeout: 45000 },
    );
    await page.evaluate(async () => {
      const app = await import('/static/player.js');
      const { PlayerVideoStream } = await import('/static/video-stream.js');
      const { default: Hls } = await import('/static/vendor/hls.min.mjs');
      window.originalVideo = app.video;
      window.heldMedia = new Map();
      app.video.addEventListener('seeking', () => window.recoverySeeks++);
      const accept = PlayerVideoStream.prototype.accept;
      PlayerVideoStream.prototype.accept = function (header, data) {
        if (
          window.holdInitialMedia &&
          typeof header === 'object' &&
          header !== null &&
          'type' in header &&
          header.type === 'segment'
        ) {
          const records = window.heldMedia.get(this) || [];
          if (records.length < 3) records.push([header, data]);
          window.heldMedia.set(this, records);
          return;
        }
        return accept.call(this, header, data);
      };
      const attach = Hls.prototype.attachMedia;
      Hls.prototype.attachMedia = function (...args) {
        window.decoderAttachments++;
        return attach.apply(this, args);
      };
      // Only the pending-initial-fragment deadline is accelerated. Video bytes,
      // native decoding, transport reconnects and media clocks remain real.
      const timeout = AbortSignal.timeout.bind(AbortSignal);
      AbortSignal.timeout = (milliseconds) => {
        if (milliseconds === 45000) {
          window.readinessDeadlines++;
          milliseconds = 1000;
        }
        return timeout(milliseconds);
      };
    });
    const initial = await read();
    for (const kind of ['hidden', 'offline']) {
      for (const paused of [true, false]) {
        const before = await beginRecovery(paused);
        await suspend(kind, true);
        await page.waitForTimeout(1400);
        const held = await read();
        assert.equal(held.hls, false, 'Intentional suspension must not construct a decoder.');
        assert.equal(held.desiredPaused, paused);
        assert.equal(held.restore!.session, initial.session);
        assert.equal(held.fallback, false);
        await releaseMedia();
        await suspend(kind, false);
        await waitForPlayer(
          page,
          ({ app }) =>
            app.hls &&
            app.videoStream === window.pendingTransport &&
            app.videoStream!.connected &&
            !app.pageReplay.attaching &&
            app.video.readyState >= 2 &&
            !app.video.seeking,
          null,
          { timeout: 15000 },
        );
        const after = await read();
        assert.equal(after.session, initial.session);
        assert.equal(after.sameVideo, true);
        assert.equal(after.videos, 1);
        assert.equal(after.sameTransport, true, 'Resume must reuse the current transport initializer.');
        assert.equal(after.decoders, 1);
        assert.equal(after.fallback, false);
        assert.equal(after.paused, paused);
        assert.equal(after.desiredPaused, paused);
        assert.equal(after.followLive, false);
        assert.equal(after.restore, null);
        assert(after.seeks <= 1, `One restoration seek, observed ${after.seeks}.`);
        if (paused) {
          assert(Math.abs(after.time - before.time) < 0.1);
          assert(Math.abs(after.printerTime! - before.printerTime!) < 0.1);
        } else {
          assert(after.time >= before.time - 0.1 && after.time <= before.time + after.at - before.at + 1);
          assert(after.offset >= 8);
        }
        await page.waitForTimeout(1200);
        const later = await read();
        if (paused) assert(Math.abs(later.time - after.time) < 0.1);
        else assert(later.time > after.time + 0.6, 'Resumed replay must decode advancing footage.');
        console.log(
          JSON.stringify({
            browser: name,
            suspension: kind,
            paused,
            deadlineMs: 1000,
            deadlines: held.deadlines,
            before: before.time,
            restored: after.time,
            seeks: after.seeks,
            sameSessionVideoTransport: true,
            decoderAttachments: after.decoders,
          }),
        );
      }
    }
    assert.equal(sessions.length, 1);

    // A newer explicit Live action must win while the initializer is suspended.
    await beginRecovery(true);
    await suspend('hidden', true);
    await page.waitForTimeout(1400);
    await page.evaluate(async () => (await import('/static/player.js')).pageReplay.goLive());
    await releaseMedia();
    await suspend('hidden', false);
    await waitForPlayer(
      page,
      ({ app }) =>
        app.hls &&
        !app.pageReplay.attaching &&
        app.video.readyState >= 2 &&
        !app.video.paused &&
        app.pageReplay.followLive &&
        app.pageReplay.bounds().end - app.video.currentTime < 8,
      null,
      { timeout: 15000 },
    );
    assert.equal((await read()).session, initial.session);
    assert.equal((await read()).decoders, 1);

    // Expiry can start opening a new session before detach destroys the old
    // transport. Release old media in that gap to exercise session ownership.
    const beforeExpiry = await beginRecovery(true);
    const sessionGate = new Promise<void>((resolve) => {
      releaseSession = resolve;
    });
    await page.route('**/api/sessions', async (route: Route) => {
      await sessionGate;
      await route.continue();
    });
    await page.evaluate(async () => {
      const app = await import('/static/player.js');
      window.cancelledTransport = app.videoStream;
      app.pageReplay.updateMetadata(app.pageReplay.session!.session_id, null);
    });
    await waitForPlayer(page, ({ app }) => app.pageReplay.opening && !app.pageReplay.session);
    await releaseMedia();
    await waitForPlayer(page, () => window.cancelledTransport!.nextSequence !== null, null, {
      timeout: 10000,
    });
    assert.equal((await read()).hls, false, 'Old media must not attach to a session being replaced.');
    await page.evaluate(() => window.cancelledTransport!.onFailure());
    assert.equal((await read()).fallback, false);
    releaseSession!();
    await page.unrouteAll({ behavior: 'wait' });
    await waitForPlayer(
      page,
      ({ app, arg }) =>
        app.pageReplay.session?.session_id !== arg &&
        app.hls &&
        app.videoStream?.connected &&
        app.video.readyState >= 2 &&
        !app.video.paused &&
        !app.pageReplay.attaching,
      beforeExpiry.session,
      { timeout: 20000 },
    );
    const replacement = await read();
    assert.equal(replacement.followLive, true);
    assert.equal(replacement.desiredPaused, false);
    assert.equal(replacement.sameVideo, true);
    assert.equal(replacement.videos, 1);
    assert.equal(
      await page.evaluate(
        () => window.cancelledTransport!.destroyed && window.cancelledTransport!.listeners.size === 0,
      ),
      true,
    );
    assert.equal(sessions.length, 2);

    // A camera change destroys the suspended initializer. Its later timeout or
    // failure callback must not mutate the new camera's session or decoder.
    const cameras = await (await context.request.get(`${base}/api/cameras`)).json();
    const other = cameras.cameras.find(
      (camera: BackendContractsTypes.CameraInfo) => camera.id !== replacement.camera,
    );
    const configured = await context.request.post(`${base}/api/cameras/${other.id}/configure`, {
      headers: { 'X-Viewer-Request': '1' },
      data: { access_code: 'fixture-code' },
    });
    assert.equal(configured.status(), 200);
    await beginRecovery(true);
    await suspend('hidden', true);
    await page.waitForTimeout(1400);
    await page.evaluate(async (cameraId) => {
      const app = await import('/static/player.js');
      window.cancelledTransport = app.videoStream;
      document
        .querySelector<HTMLElementTagNameMap['printer-list']>('#camera-list')!
        .dispatchEvent(new CustomEvent('printer-select', { detail: { cameraId } }));
    }, other.id);
    assert.equal(
      await page.evaluate(
        () => window.cancelledTransport!.destroyed && window.cancelledTransport!.listeners.size === 0,
      ),
      true,
    );
    await releaseMedia();
    await suspend('hidden', false);
    await waitForPlayer(
      page,
      ({ app, arg }) =>
        app.selectedCamera === arg &&
        app.pageReplay.session?.camera_id === arg &&
        app.videoStream?.connected &&
        app.hls &&
        app.video.readyState >= 2 &&
        !app.video.paused &&
        !app.pageReplay.attaching,
      other.id,
      { timeout: 20000 },
    );
    const newCamera = await read();
    assert.notEqual(newCamera.session, replacement.session);
    assert.equal(newCamera.followLive, true);
    assert.equal(newCamera.desiredPaused, false);
    assert.equal(newCamera.sameVideo, true);
    assert.equal(newCamera.videos, 1);
    await page.evaluate(async () => {
      window.newCameraHls = (await import('/static/player.js')).hls;
      window.cancelledTransport!.onFailure();
      window.cancelledTransport!.notify();
    });
    await page.waitForTimeout(2200);
    assert.equal((await read()).session, newCamera.session);
    assert.equal((await read()).fallback, false);
    assert.equal(
      await page.evaluate(async () => (await import('/static/player.js')).hls === window.newCameraHls),
      true,
    );
    assert.equal(sessions.length, 3);
    assert.deepEqual(errors, []);
    console.log(
      `${name}: hidden/offline deadlines preserve paused/playing replay; explicit Live, session expiry and camera cancellation passed.`,
    );
  } catch (error) {
    console.error(
      name,
      error instanceof Error ? error.stack : String(error),
      await read().catch(() => null),
      messages.slice(-15),
    );
    throw error;
  } finally {
    releaseSession?.();
    await page.unrouteAll({ behavior: 'wait' }).catch(() => {});
    await page.goto('about:blank').catch(() => {});
    await browser.close();
  }
}
