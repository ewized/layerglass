import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';

const base = process.env.VIEWER_URL || 'http://127.0.0.1:8080';
const output = process.env.OUTPUT_DIR;

async function run(name, engine) {
  const browser = await engine.launch({ headless: true, args: name === 'chromium' ? ['--no-sandbox'] : [] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 },
    isMobile: true, hasTouch: true, reducedMotion: 'no-preference', serviceWorkers: 'block' });
  const page = await context.newPage();
  const errors = [];
  const mediaRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (/\/(?:video|live\.m3u8|segment-\d+\.ts|frame\.jpg|preview\.jpg)$/.test(path)) mediaRequests.push(path);
  });
  await page.addInitScript(() => {
    window.diffusionReads = [];
    const read = CanvasRenderingContext2D.prototype.getImageData;
    CanvasRenderingContext2D.prototype.getImageData = function(...args) {
      if (this.canvas.width <= 32 && this.canvas.height <= 32) window.diffusionReads.push({
        width: this.canvas.width, height: this.canvas.height, attached: this.canvas.isConnected, at: performance.now(),
      });
      return read.apply(this, args);
    };
  });
  const fill = (color, reset = false) => page.evaluate(async ({ color, reset }) => {
    const viewer = document.querySelector('printer-camera-view');
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 18;
    const context = canvas.getContext('2d');
    context.fillStyle = color;
    context.fillRect(0, 0, 32, 18);
    viewer.image.hidden = false;
    const loaded = new Promise(resolve => viewer.image.addEventListener('load', resolve, { once: true }));
    viewer.image.src = canvas.toDataURL();
    await loaded;
    if (reset) viewer.clearDiffusion();
    viewer.drawDiffusion(true);
  }, { color, reset });
  const state = () => page.evaluate(() => {
    const viewer = document.querySelector('printer-camera-view');
    return { base: viewer.diffusionBase.style.background, next: viewer.diffusionNext.style.background,
      opacity: Number(getComputedStyle(viewer.diffusionNext).opacity), blending: viewer.diffusion.classList.contains('blending'),
      target: viewer.diffusionTarget, pending: viewer.diffusionPending, hidden: viewer.diffusion.hidden,
      count: window.diffusionReads.length };
  });
  const settled = () => page.waitForFunction(() => {
    const viewer = document.querySelector('printer-camera-view');
    return !viewer.diffusionTarget && !viewer.diffusionPending;
  }, undefined, { timeout: 6000 });
  try {
    await page.goto(base);
    await page.waitForFunction(() => {
      const video = document.querySelector('video');
      return video?.readyState >= 3 && !video.paused && video.currentTime > 0 &&
        document.querySelector('#overlay').hidden && !document.querySelector('#video-diffusion').hidden;
    }, undefined, { timeout: 45000 });
    await page.evaluate(async () => {
      const app = await import('/static/player.js');
      window.diffusionOriginal = { video: app.video, decoder: app.hls, session: app.pageReplay.session.session_id,
        frames: app.video.getVideoPlaybackQuality().totalVideoFrames };
      window.diffusionReads = [];
    });
    mediaRequests.length = 0;
    await page.waitForTimeout(8500);
    const playback = await page.evaluate(() => {
      const viewer = document.querySelector('printer-camera-view');
      return { frames: viewer.video.getVideoPlaybackQuality().totalVideoFrames - window.diffusionOriginal.frames,
        reads: window.diffusionReads, videos: document.querySelectorAll('video').length,
        canvases: document.querySelectorAll('canvas').length, controls: viewer.video.controls,
        viewWidth: viewer.viewWidth, viewHeight: viewer.viewHeight,
        filter: getComputedStyle(viewer.diffusion).filter, background: viewer.diffusionBase.style.background };
    });
    assert(playback.frames > 80, `${name}: native decoding must keep progressing (${playback.frames} frames).`);
    assert(playback.reads.length >= 2 && playback.reads.length <= 5,
      `${name}: steady playback should only sample about once every 2.2 seconds (${playback.reads.length}).`);
    assert(playback.reads.every(read => read.width === 32 && read.height === 18 && !read.attached));
    assert.equal(playback.videos, 1);
    assert.equal(playback.canvases, 0, 'The sampling canvas must never be a visible rendering layer.');
    assert.equal(playback.controls, false);
    assert.equal(playback.filter, 'none', 'Diffusion must not need a full-screen blur.');
    assert.match(playback.background, /radial-gradient/);
    assert.deepEqual(mediaRequests, [], 'Updating diffusion must not make additional media requests.');
    if (output) await page.screenshot({ path: `${output}/${name}-portrait.png` });

    await page.evaluate(() => {
      const viewer = document.querySelector('printer-camera-view');
      viewer.video.pause();
      viewer.clearDiffusion();
    });
    await fill('red', true);
    const red = (await state()).base;
    assert.match(red, /255, 0, 0/);
    await fill('blue');
    const start = await state();
    assert.equal(start.base, red);
    assert.match(start.next, /0, 0, 255/);
    assert(start.blending && start.opacity < 0.2);
    await page.waitForTimeout(650);
    const middle = await state();
    assert(middle.opacity > 0.05 && middle.opacity < 0.95,
      `${name}: gradients should be partway through a CSS crossfade (${middle.opacity}).`);
    assert.equal(middle.base, red);
    await settled();
    assert.match((await state()).base, /0, 0, 255/);

    await fill('red');
    const fading = (await state()).next;
    await page.waitForTimeout(250);
    await fill('lime');
    const queued = await state();
    assert.equal(queued.next, fading, 'A new seek must not replace a layer while it is visible.');
    assert(queued.pending?.includes('0 255 0'));
    await settled();
    assert.match((await state()).base, /0, 255, 0/);

    await fill('red');
    await fill('blue');
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
      const viewer = document.querySelector('printer-camera-view');
      for (let i = 0; i < 10; i++) viewer.drawDiffusion(true);
    });
    const hidden = await state();
    assert.match(hidden.base, /0, 0, 255/);
    assert.equal(hidden.blending, false);
    await page.waitForTimeout(2500);
    assert.equal((await state()).count, hidden.count, 'A hidden page must stop sampling.');
    await page.evaluate(() => {
      delete document.hidden;
      document.dispatchEvent(new Event('visibilitychange'));
    });

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await fill('red');
    const still = await state();
    assert.match(still.base, /255, 0, 0/);
    assert.equal(still.blending, false);
    await page.evaluate(() => {
      const viewer = document.querySelector('printer-camera-view');
      for (let i = 0; i < 10; i++) viewer.drawDiffusion();
    });
    assert.equal((await state()).count, still.count, 'Reduced motion must keep a still gradient.');

    // Resize the camera surface rather than rotating the browser window. That
    // isolates letterboxing from the separate automatic-fullscreen feature.
    await page.evaluate(() => {
      const viewer = document.querySelector('printer-camera-view');
      viewer.style.width = '640px';
      viewer.style.height = '360px';
    });
    await page.waitForFunction(() => document.querySelector('#video-diffusion').hidden);
    const covered = await state();
    await page.evaluate(() => document.querySelector('printer-camera-view').drawDiffusion(true));
    assert.equal((await state()).count, covered.count, 'A video that fills the player must not be sampled.');

    await page.evaluate(() => {
      const viewer = document.querySelector('printer-camera-view');
      viewer.style.removeProperty('width');
      viewer.style.removeProperty('height');
    });
    await page.waitForFunction(({ width, height }) => {
      const viewer = document.querySelector('printer-camera-view');
      return viewer.viewWidth === width && viewer.viewHeight === height;
    }, { width: playback.viewWidth, height: playback.viewHeight });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await fill('red');
    await fill('blue');
    await page.evaluate(() => document.querySelector('printer-camera-view').clearDiffusion());
    const cleared = await state();
    assert(cleared.hidden && !cleared.target && !cleared.pending && !cleared.blending);
    await page.waitForTimeout(2500);
    const afterClear = await state();
    assert(afterClear.hidden || afterClear.count > cleared.count,
      'A canceled transition must not restore a cleared background without a new frame sample.');
    await page.evaluate(async () => {
      const app = await import('/static/player.js');
      document.querySelector('#jpeg').hidden = true;
      app.video.hidden = false;
      await app.video.play();
      document.querySelector('printer-camera-view').drawDiffusion(true);
    });
    await page.waitForFunction(() => !document.querySelector('#video-diffusion').hidden);
    assert.equal(await page.evaluate(async () => {
      const app = await import('/static/player.js');
      return app.video === window.diffusionOriginal.video && app.hls === window.diffusionOriginal.decoder &&
        app.pageReplay.session.session_id === window.diffusionOriginal.session;
    }), true, 'Gradient transitions must preserve the native decoder and replay session.');
    assert.deepEqual(errors, []);
    console.log(`${name}: native video (${playback.frames} frames/8.5s), ${playback.reads.length} tiny color samples, CSS fade/queued seeks, hidden/reduced-motion/full-frame suspension, cleanup, and zero extra media requests passed.`);
  } finally { await browser.close(); }
}

for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) await run(name, engine);
