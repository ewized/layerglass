import type { BrowserType } from 'playwright';
import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';

const base = process.env.VIEWER_URL || 'http://127.0.0.1:8080';

async function run(name: string, engine: BrowserType, managed = false) {
  const browser = await engine.launch({
    headless: true,
    ...(engine === chromium ? { channel: 'chromium', args: ['--no-sandbox'] } : {}),
  });
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const errors: Array<string> = [];
  const requests: Array<string> = [];
  const messages: Array<string> = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => requests.push(new URL(request.url()).pathname));
  page.on('console', (message) => messages.push(message.text()));
  await page.addInitScript((managed) => {
    // This suite covers the generic native API and Safari compatibility.
    // Desktop Google's SDK/session transport is exercised separately.
    Object.defineProperty(navigator, 'presentation', { configurable: true, value: undefined });
    window.mediaActions = new Map();
    if (navigator.mediaSession) {
      const native = navigator.mediaSession.setActionHandler.bind(navigator.mediaSession);
      navigator.mediaSession.setActionHandler = (name: MediaSessionAction, handler) => {
        native(name, handler);
        if (handler) window.mediaActions.set(name, (details = {}) => handler({ action: name, ...details }));
        else window.mediaActions.delete(name);
      };
    }
    if (managed) {
      // Exercise hls.js's real ManagedMediaSource attachment branch with a
      // platform MediaSource. Linux test shells do not supply Apple's MMS.
      window.ManagedMediaSource = window.MediaSource;
      Object.defineProperty(window.MediaSource.prototype, 'streaming', { get: () => true });
      HTMLVideoElement.prototype.webkitShowPlaybackTargetPicker = function () {
        window.castCalls.push({ kind: 'airplay', activated: navigator.userActivation.isActive });
      };
    }
    window.castCalls = [];
  }, managed);
  try {
    await page.goto(base);
    await page.waitForFunction(
      () =>
        (document.querySelector<HTMLVideoElement>('video')?.videoWidth ?? Number.NaN) > 0 &&
        !document.querySelector<HTMLVideoElement>('video')!.paused &&
        document.querySelector<HTMLElementTagNameMap['printer-loading']>('#overlay')!.hidden,
      undefined,
      { timeout: 45000 },
    );
    const original = await page.evaluate(async () => {
      const app = await import('/static/player.js');
      window.mediaApp = app;
      window.originalMedia = {
        video: app.video,
        decoder: app.hls,
        source: app.video.currentSrc,
        session: app.pageReplay.session!.session_id,
      };
      return {
        nativePicker: typeof app.video.webkitShowPlaybackTargetPicker === 'function',
        managed: typeof window.ManagedMediaSource === 'function',
        continuous: Boolean(app.videoStream),
        hasRemote: Boolean(app.video.remote),
        metadata: navigator.mediaSession?.metadata?.title,
        id: navigator.mediaSession?.metadata?.artist,
        playbackState: navigator.mediaSession?.playbackState,
      };
    });
    assert.equal(original.metadata, 'Bambu Lab X2D');
    assert.equal(original.id, '20P000000000001');
    assert.equal(original.playbackState, 'playing');
    assert.equal(
      await page.locator('video').evaluate((video: HTMLVideoElement) => video.duration),
      Infinity,
      'The native media timeline must identify this feed as live, without a fake final duration.',
    );
    assert.deepEqual(
      await page
        .locator('#player-toolbar > button')
        .evaluateAll((buttons: HTMLButtonElement[]) => buttons.map((button) => button.id)),
      ['pause-button', 'options-button', 'cast-button', 'fullscreen-button'],
    );
    if (managed) {
      assert.equal(original.continuous, true);
      assert.deepEqual(
        await page.locator('video').evaluate((video: HTMLVideoElement) => ({
          remoteDisabled: video.disableRemotePlayback,
          hasSrc: video.hasAttribute('src'),
          sources: [...video.querySelectorAll<HTMLElementTagNameMap['source']>('source')].map((source) => ({
            blob: source.src.startsWith('blob:'),
            type: source.type,
          })),
        })),
        {
          remoteDisabled: false,
          hasSrc: false,
          sources: [
            { blob: true, type: 'video/mp4' },
            { blob: false, type: 'application/x-mpegURL' },
          ],
        },
      );
    }
    if (!original.nativePicker && !original.hasRemote) {
      assert.equal(
        await page.locator('#cast-button').isDisabled(),
        true,
        'Linux WebKit has no OS casting backend; the button must initially be disabled.',
      );
    }
    const usesWebkit = await page.evaluate(() => {
      const video = window.mediaApp.video;
      const prompt = (kind: string) => {
        window.castCalls.push({ kind, activated: navigator.userActivation.isActive });
        if (window.denyCast) return Promise.reject(new DOMException('Dismissed', 'NotAllowedError'));
        return new Promise<void>((resolve) => {
          window.finishCast = resolve;
        });
      };
      if (typeof video.webkitShowPlaybackTargetPicker === 'function' || !video.remote) {
        video.webkitShowPlaybackTargetPicker = () => {
          prompt('airplay');
        };
      } else if (video.remote) video.remote.prompt = () => prompt('remote');
      window.mediaApp.playerMedia.update();
      return window.mediaApp.playerMedia.webkitPicker;
    });
    const cast = page.getByRole('button', { name: 'Cast', exact: true });
    await cast.click();
    assert.equal(await page.evaluate(() => window.castCalls.length), 1);
    assert.equal(
      await page.evaluate(() => window.castCalls[0]!.activated),
      true,
      'The native picker must receive a real transient user activation.',
    );
    if (!usesWebkit) {
      assert.equal(await cast.isDisabled(), true);
      await page.evaluate(() => window.finishCast());
      await page.waitForFunction(() => !window.mediaApp.playerMedia.prompting);
    }
    assert.deepEqual(
      await page.evaluate(() => ({
        video: window.mediaApp.video === window.originalMedia.video,
        decoder: window.mediaApp.hls === window.originalMedia.decoder,
        source: window.mediaApp.video.currentSrc === window.originalMedia.source,
        session: window.mediaApp.pageReplay.session!.session_id === window.originalMedia.session,
        customControls: !window.mediaApp.video.controls,
      })),
      { video: true, decoder: true, source: true, session: true, customControls: true },
    );

    if (usesWebkit && original.hasRemote) {
      await page.evaluate(() => {
        const remote = window.mediaApp.video.remote;
        window.remoteState = 'connecting';
        Object.defineProperty(remote, 'state', { configurable: true, get: () => window.remoteState });
        remote.dispatchEvent(new Event('connecting'));
        window.remoteState = 'disconnected';
        remote.dispatchEvent(new Event('disconnect'));
      });
      assert.equal(
        await page.evaluate(() => window.mediaApp.hls === window.originalMedia.decoder),
        true,
        'Cancelling a pending Safari connection must keep its original decoder.',
      );
    }

    // Browser/OS actions pause, resume and seek the same native video and page
    // history. Call the handlers registered with the real Media Session API.
    await page.evaluate(() => window.mediaActions.get('pause')!());
    await page.waitForFunction(
      () => window.mediaApp.video.paused && navigator.mediaSession.playbackState === 'paused',
    );
    await page.waitForFunction(() => window.mediaApp.pageReplay.session!.end_seconds >= 8);
    await page.evaluate(() => window.mediaActions.get('seekbackward')!({ seekOffset: 2 }));
    assert.equal(await page.evaluate(() => window.mediaApp.pageReplay.followLive), false);
    await page.evaluate(() => window.mediaActions.get('play')!());
    await page.waitForFunction(
      () => !window.mediaApp.video.paused && navigator.mediaSession.playbackState === 'playing',
    );
    await page.evaluate(() => window.mediaActions.get('seekto')!({ seekTime: Infinity }));
    assert.equal(await page.evaluate(() => window.mediaApp.pageReplay.followLive), true);
    assert.equal(
      await page.evaluate(
        () => window.mediaApp.pageReplay.session!.session_id === window.originalMedia.session,
      ),
      true,
    );

    // Native connection events must keep SSE and the recording lease alive in
    // the background; returning from Safari AirPlay restores local playback.
    await page.evaluate(() => {
      const video = window.mediaApp.video;
      window.remoteState = 'connected';
      if (window.mediaApp.playerMedia.webkitPicker) {
        Object.defineProperty(video, 'webkitCurrentPlaybackTargetIsWireless', {
          configurable: true,
          get: () => window.remoteState === 'connected',
        });
        video.dispatchEvent(new Event('webkitcurrentplaybacktargetiswirelesschanged'));
      } else {
        Object.defineProperty(video.remote, 'state', { configurable: true, get: () => window.remoteState });
        video.remote.dispatchEvent(new Event('connect'));
      }
      window.castUpdates = window.mediaApp.updates.source;
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    assert.equal(await cast.getAttribute('aria-pressed'), 'true');
    assert.equal(await page.evaluate(() => window.mediaApp.updates.source === window.castUpdates), true);
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      window.remoteState = 'disconnected';
      const video = window.mediaApp.video;
      if (window.mediaApp.playerMedia.webkitPicker)
        video.dispatchEvent(new Event('webkitcurrentplaybacktargetiswirelesschanged'));
      else video.remote.dispatchEvent(new Event('disconnect'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForFunction(
      () =>
        !window.mediaApp.playerMedia.remoteActive &&
        window.mediaApp.video.readyState >= 2 &&
        !window.mediaApp.video.paused,
    );
    assert.equal(await cast.getAttribute('aria-pressed'), 'false');
    assert.equal(
      await page.evaluate(
        () => window.mediaApp.pageReplay.session!.session_id === window.originalMedia.session,
      ),
      true,
    );

    await page.setViewportSize({ width: 320, height: 568 });
    await page.evaluate(() => window.mediaApp.playerChrome.show());
    const boxes = await page.locator('#player-toolbar > button').evaluateAll((buttons: HTMLButtonElement[]) =>
      buttons.map((button) => {
        const rect = button.getBoundingClientRect();
        return { id: button.id, left: rect.left, right: rect.right, width: rect.width };
      }),
    );
    for (const box of boxes)
      assert(box.left >= 0 && box.right <= 320 && box.width >= 44, JSON.stringify(boxes));
    for (let i = 1; i < boxes.length; i++)
      assert(boxes[i]!.left >= boxes[i - 1]!.right, JSON.stringify(boxes));
    if (managed) {
      assert.equal(
        requests.filter((path) => path.endsWith('live.m3u8')).length,
        0,
        'The AirPlay alternative must not add playlist polling to local continuous playback.',
      );
    }
    assert.deepEqual(errors, []);
    console.log(
      `${name}: Cast toolbar placement, transient activation, unchanged local decoder/history on picker, native Media Session metadata/playback/rewind, remote state/background lease, 320px controls, ${managed ? 'real hls.js MMS branch with an unfetched HLS AirPlay alternative' : 'native video playback'} passed.`,
    );
    await page.goto('about:blank');
  } catch (error) {
    console.error(`${name} casting diagnostics:`, { errors, messages: messages.slice(-15) });
    throw error;
  } finally {
    await browser.close();
  }
}

await run('Chromium', chromium);
await run('Safari attachment compatibility', chromium, true);
await run('WebKit', webkit);
