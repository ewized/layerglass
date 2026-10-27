import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const base = process.env.VIEWER_URL || 'http://127.0.0.1:8080';
// A regular temporary profile is required: incognito mode rejects installation
// regardless of manifest validity. This profile lives only in the test container.
const context = await chromium.launchPersistentContext(`/tmp/printer-camera-pwa-install-${process.pid}`, {
  headless: true,
  channel: 'chromium',
  args: ['--no-sandbox'],
  viewport: { width: 1280, height: 720 },
});
const page = context.pages()[0] || (await context.newPage());
const errors: Array<string> = [];
const insecure: Array<string> = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('request', (request) => {
  if (base.startsWith('https:') && request.url().startsWith('http://')) insecure.push(request.url());
});

try {
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () =>
      navigator.serviceWorker.controller &&
      document.querySelector<HTMLVideoElement>('video')!.videoWidth > 0 &&
      !document.querySelector<HTMLVideoElement>('video')!.paused &&
      document.querySelector<HTMLElementTagNameMap['printer-loading']>('#overlay')!.hidden,
    null,
    { timeout: 45000 },
  );
  const cdp = await context.newCDPSession(page);
  const manifest = await cdp.send('Page.getAppManifest');
  assert.equal(manifest.url, new URL('/manifest.webmanifest', base).href);
  assert.deepEqual(manifest.errors, []);
  assert.deepEqual((await cdp.send('Page.getInstallabilityErrors')).installabilityErrors, []);
  console.log(
    'Regular-profile Chromium: HTTPS/localhost manifest and installability checks report zero errors.',
  );
  assert.deepEqual(
    await page
      .locator('#player-toolbar > button')
      .evaluateAll((buttons: HTMLButtonElement[]) => buttons.map((button) => button.id)),
    ['pause-button', 'options-button', 'cast-button', 'fullscreen-button'],
  );
  assert.equal(await page.locator('#cast-button').isDisabled(), false);
  assert.equal(await page.locator('video').evaluate((video: HTMLVideoElement) => video.duration), Infinity);
  assert.equal(
    await page.evaluate(
      () =>
        navigator.mediaSession.metadata!.title ===
          document.querySelector<HTMLElement>('#camera-name')!.textContent &&
        navigator.mediaSession.metadata!.artist ===
          document.querySelector<HTMLElement>('#camera-id')!.textContent &&
        navigator.mediaSession.playbackState === 'playing',
    ),
    true,
  );
  console.log(
    'Native Cast API enabled in the toolbar; browser Media Session carries the displayed printer model/ID and playing state.',
  );
  await page.evaluate(async () => {
    const app = await import('/static/player.js');
    window.pwaPipCheck = { video: app.video, hls: app.hls, session: app.pageReplay.session!.session_id };
  });
  const dimensions = await page
    .locator('video')
    .evaluate((video: HTMLVideoElement) => [video.videoWidth, video.videoHeight]);
  await page.locator('video').click({ button: 'right', position: { x: 350, y: 250 } });
  await page.locator('[data-player-action="mini"]').click();
  await page.waitForFunction(
    () => document.pictureInPictureElement === document.querySelector<HTMLVideoElement>('video'),
  );
  assert.deepEqual(
    await page.evaluate(() => {
      return {
        sameVideo: document.pictureInPictureElement === window.pwaPipCheck.video,
        customPageControls: !document.querySelector<HTMLVideoElement>('video')!.controls,
        toolbar: Boolean(
          document.querySelector<HTMLElementTagNameMap['printer-controls']>('#player-controls'),
        ),
        header: Boolean(document.querySelector<HTMLElement>('.player-header')),
        timeline: Boolean(document.querySelector<HTMLInputElement>('#replay-slider')),
        restore: document.querySelector<HTMLButtonElement>('#fullscreen-button')!.getAttribute('aria-label'),
        documentPip: Boolean(window.documentPictureInPicture?.window),
      };
    }),
    {
      sameVideo: true,
      customPageControls: true,
      toolbar: true,
      header: true,
      timeline: true,
      restore: 'Restore player',
      documentPip: false,
    },
  );
  await page.evaluate(() => document.querySelector<HTMLVideoElement>('video')!.pause());
  await page.waitForFunction(() =>
    Number.isFinite(document.querySelector<HTMLVideoElement>('video')!.duration),
  );
  await page.evaluate(() => document.querySelector<HTMLVideoElement>('video')!.play());
  assert.equal(
    await page.locator('video').evaluate((video: HTMLVideoElement) => Number.isFinite(video.duration)),
    true,
    'Native PiP must stay in replay when resuming a paused frame.',
  );
  await page.evaluate(async () => (await import('/static/player.js')).pageReplay.goLive());
  await page.waitForFunction(() => document.querySelector<HTMLVideoElement>('video')!.duration === Infinity);
  await page.locator('#fullscreen-button').click();
  await page.waitForFunction(
    () =>
      !document.pictureInPictureElement &&
      document.querySelector<HTMLVideoElement>('video') === window.pwaPipCheck.video &&
      !document.querySelector<HTMLVideoElement>('video')!.paused,
  );
  assert.equal(
    await page.evaluate(async () => {
      const app = await import('/static/player.js');
      return (
        app.hls === window.pwaPipCheck.hls &&
        app.pageReplay.session!.session_id === window.pwaPipCheck.session
      );
    }),
    true,
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(insecure, []);
  if (process.env.SCREENSHOT_PATH) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(async () => (await import('/static/player.js')).playerChrome.show());
    await page.screenshot({ path: process.env.SCREENSHOT_PATH });
  }
  console.log(
    `Live ${dimensions.join('×')}, native video PiP, retained main-page controls/header/timeline and same decoder/session on Restore passed; zero page errors or insecure requests.`,
  );
} finally {
  await context.close();
}
