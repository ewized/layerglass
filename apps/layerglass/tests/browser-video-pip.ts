import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { waitForPlayer } from './player-page.ts';

// Full Chromium opens an actual browser video PiP surface on both secure and
// ordinary LAN origins. Secure origins also expose Document PiP, which must
// remain unused.
const browser = await chromium.launch({ headless: true, channel: 'chromium', args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors: Array<string> = [];
const messages: Array<string> = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => messages.push(message.text()));

async function openMini() {
  await page.locator('#player').click({ button: 'right', position: { x: 900, y: 400 } });
  await page.locator('[data-player-action="mini"]').click();
}

async function ready() {
  await page.waitForFunction(
    () =>
      (document.querySelector<HTMLVideoElement>('video')?.videoWidth ?? Number.NaN) > 0 &&
      !document.querySelector<HTMLVideoElement>('video')!.paused &&
      document.querySelector<HTMLElementTagNameMap['printer-loading']>('#overlay')!.hidden,
    undefined,
    { timeout: 45000 },
  );
}

try {
  await page.goto(process.env.VIEWER_URL!);
  await ready();
  const secure = process.env.EXPECT_SECURE === '1';
  assert.deepEqual(
    await page.evaluate(() => ({
      secure: isSecureContext,
      documentPip: Boolean(window.documentPictureInPicture),
      videoPip: document.pictureInPictureEnabled,
    })),
    { secure, documentPip: secure, videoPip: true },
  );
  await page.evaluate(async () => {
    const app = await import('/static/player.js');
    window.pipApp = app;
    window.documentPipCalls = 0;
    if (window.documentPictureInPicture)
      window.documentPictureInPicture.requestWindow = () => {
        window.documentPipCalls++;
        throw new Error('Document PiP must not be requested');
      };
    window.originalPip = {
      video: app.video,
      decoder: app.hls,
      source: app.video.currentSrc,
      session: app.pageReplay.session!.session_id,
      updates: app.updates.source,
      header: document.querySelector<HTMLElement>('.player-header'),
      slider: document.querySelector<HTMLInputElement>('#replay-slider'),
      stats: document.querySelector<HTMLElementTagNameMap['printer-stats']>('#player-stats'),
    };
  });
  const originalBounds = await page.locator('#player').boundingBox();
  await openMini();
  await page.waitForFunction(
    () => document.pictureInPictureElement === document.querySelector<HTMLVideoElement>('video'),
  );
  assert.equal(
    await page.locator('video').evaluate((video: HTMLVideoElement) => video.duration),
    Infinity,
    'Native PiP identifies live playback as LIVE.',
  );
  assert.equal(await page.locator('.native-mini-player').count(), 1);
  assert.equal(await page.locator('.document-mini-player').count(), 0);
  assert.equal(page.context().pages().length, 1, 'Native PiP must not open an HTML player window.');
  assert.deepEqual(
    await page.locator('#player').boundingBox(),
    originalBounds,
    'Browser video PiP must leave the page full size.',
  );
  assert.equal(await page.evaluate(() => window.documentPipCalls), 0);
  assert.equal(
    await page.evaluate(
      () =>
        document.querySelector<HTMLElement>('.player-header') === window.originalPip.header &&
        document.querySelector<HTMLInputElement>('#replay-slider') === window.originalPip.slider &&
        document.querySelector<HTMLElementTagNameMap['printer-stats']>('#player-stats') ===
          window.originalPip.stats &&
        document.querySelector<HTMLVideoElement>('video') === window.originalPip.video,
    ),
    true,
    'The header, timeline, stats and native video element stay in the main document.',
  );
  await page.waitForFunction(() => !document.querySelector<HTMLElement>('#video-diffusion')!.hidden);
  assert.equal(await page.locator('#fullscreen-button').getAttribute('aria-label'), 'Restore player');
  await page.evaluate(async () => (await import('/static/player.js')).playerTools.showStats(true));
  assert.equal(
    await page.locator('[data-stats-section="activity"] [data-stat="Mini player"]').textContent(),
    'Active',
  );
  assert.equal(await page.locator('[data-stat="Printer scan"]').count(), 0);
  await page.getByRole('button', { name: 'Pause video', exact: true }).click();
  await page.waitForFunction(
    () =>
      document.pictureInPictureElement instanceof HTMLVideoElement && document.pictureInPictureElement.paused,
  );
  await page.waitForFunction(() =>
    Number.isFinite(document.querySelector<HTMLVideoElement>('video')!.duration),
  );
  await page.waitForFunction(() => window.pipApp.pageReplay.session!.end_seconds >= 6);
  await page.evaluate(() => {
    window.pipScrubCommits = 0;
    window.addEventListener('replaypositionchange', () => window.pipScrubCommits++);
  });
  const slider = await page.locator('#replay-slider').boundingBox();
  const pausedAt = await page.locator('video').evaluate((video: HTMLVideoElement) => video.currentTime);
  await page.mouse.move(slider!.x + slider!.width * 0.4, slider!.y + slider!.height / 2);
  await page.mouse.down();
  for (const fraction of [0.2, 0.5, 0.3])
    await page.mouse.move(slider!.x + slider!.width * fraction, slider!.y + slider!.height / 2);
  assert(
    Math.abs(
      (await page.locator('video').evaluate((video: HTMLVideoElement) => video.currentTime)) - pausedAt,
    ) < 0.1,
  );
  assert.equal(await page.evaluate(() => window.pipScrubCommits), 0);
  await page.mouse.up();
  assert.equal(
    await page.evaluate(() => window.pipScrubCommits),
    1,
    'Scrubbing the main page commits once while native PiP displays the same video.',
  );
  await page.locator('#replay-slider').press('Home');
  assert.equal(
    await page.locator('video').evaluate((video: HTMLVideoElement) => Number.isFinite(video.duration)),
    true,
    'Rewound native PiP must not retain its LIVE marker.',
  );
  await page.getByRole('button', { name: 'Return to live video', exact: true }).click();
  await ready();
  await page.waitForFunction(() => document.querySelector<HTMLVideoElement>('video')!.duration === Infinity);

  await page.evaluate(async () => {
    const app = await import('/static/player.js');
    window.pipBackground = {
      end: app.pageReplay.session!.end_seconds,
      frames: app.video.getVideoPlaybackQuality().totalVideoFrames,
    };
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await waitForPlayer(
    page,
    ({ app }) =>
      app.pageReplay.session!.end_seconds >= window.pipBackground.end + 6 &&
      app.video.getVideoPlaybackQuality().totalVideoFrames > window.pipBackground.frames + 15,
    undefined,
    { timeout: 30000 },
  );
  assert.deepEqual(
    await page.evaluate(async () => {
      const app = await import('/static/player.js');
      return {
        video: document.pictureInPictureElement === window.originalPip.video,
        streaming: app.videoStream!.connected && !app.videoStream!.suspended,
        sameUpdates: app.updates.source === window.originalPip.updates,
        sameSession: app.pageReplay.session!.session_id === window.originalPip.session,
      };
    }),
    { video: true, streaming: true, sameUpdates: true, sameSession: true },
  );
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.getByRole('button', { name: 'Restore player', exact: true }).click();
  await page.waitForFunction(() => !document.pictureInPictureElement);
  assert.equal(await page.locator('.mini-player').count(), 0);
  assert.equal(await page.locator('[data-stat="Mini player"]').count(), 0);
  assert.equal(await page.locator('.stats-section[aria-label="Activity"]').isVisible(), false);
  assert.deepEqual(
    await page.evaluate(async () => {
      const app = await import('/static/player.js');
      return {
        sameVideo: app.video === window.originalPip.video,
        sameSource: app.video.currentSrc === window.originalPip.source,
        sameDecoder: app.hls === window.originalPip.decoder,
        sameSession: app.pageReplay.session!.session_id === window.originalPip.session,
        playing: !app.video.paused,
        fullscreen: Boolean(app.playerFullscreen.active()),
        customPageControls: !app.video.controls,
      };
    }),
    {
      sameVideo: true,
      sameSource: true,
      sameDecoder: true,
      sameSession: true,
      playing: true,
      fullscreen: false,
      customPageControls: true,
    },
  );

  // Exercise browser-controlled exit independently of our Restore action.
  await openMini();
  await page.waitForFunction(
    () => document.pictureInPictureElement === document.querySelector<HTMLVideoElement>('video'),
  );
  await page.evaluate(() => document.exitPictureInPicture());
  assert.equal(await page.locator('.mini-player').count(), 0);
  assert.equal(await page.locator('[data-stat="Mini player"]').count(), 0);
  assert.equal(await page.locator('#fullscreen-button').getAttribute('aria-label'), 'Enter fullscreen');

  // A denied request must never masquerade as an active in-page mini player.
  await page.evaluate(() => {
    document.querySelector<HTMLVideoElement>('video')!.requestPictureInPicture = async () => {
      throw new DOMException('Denied', 'NotAllowedError');
    };
  });
  await openMini();
  await waitForPlayer(page, ({ app }) => !app.playerTools.miniOpening);
  assert.equal(await page.locator('.mini-player').count(), 0);
  assert.equal(await page.locator('#player-stats h3:visible').count(), 2);
  assert.equal(await page.evaluate(() => window.documentPipCalls), 0);
  assert.deepEqual(errors, []);
  console.log(
    `Chromium: native video PiP on ${secure ? 'a secure origin with Document PiP available' : 'LAN HTTP'}, retained header/timeline/stats/diffusion, main-page scrub commit, Restore/browser exit, background streaming, stable decoder/history, and denied requests passed; zero Document PiP calls.`,
  );
  await page.goto('about:blank');
} catch (error) {
  console.error('Video PiP diagnostics:', { errors, messages: messages.slice(-12) });
  throw error;
} finally {
  await browser.close();
}
