import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { waitForPlayer } from './player-page.ts';

const base = process.env.VIEWER_URL || 'http://127.0.0.1:8080';
for (const [name, engine] of Object.entries({ chromium, webkit })) {
  if (process.env.BROWSER && process.env.BROWSER !== name) continue;
  const browser = await engine.launch({ headless: true, args: name === 'chromium' ? ['--no-sandbox'] : [] });
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const errors: Array<string> = [],
    previews: Array<string> = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (request.url().includes('/preview.jpg?')) previews.push(request.url());
  });
  try {
    await page.goto(base);
    await waitForPlayer(
      page,
      ({ app }) => app.previewHistory.frames.size >= 4 && app.video.videoWidth >= 1280 && !app.video.paused,
      undefined,
      { timeout: 60000 },
    );
    await page.mouse.move(12, 12);
    await page.getByRole('button', { name: 'Pause video', exact: true }).click();
    await page.waitForTimeout(400);
    const original = await page.evaluateHandle(async () => {
      const app = await import('/static/player.js');
      return {
        video: app.video,
        hls: app.hls,
        session: app.pageReplay.session!.session_id,
        time: app.video.currentTime,
      };
    });
    const targets = await page.evaluate(async () => {
      const { previewHistory, pageReplay } = await import('/static/player.js');
      previewHistory.trim(pageReplay.session!.start_seconds);
      const bounds = pageReplay.bounds(),
        slider = document.querySelector<HTMLInputElement>('#replay-slider');
      // The actual printer's first keyframe can trim the initial advertised
      // origin. Exercise retained points inside the displayed paused window.
      return [...previewHistory.frames.values()]
        .map((frame) => frame.time)
        .filter(
          (time) =>
            time >= Math.max(bounds.start, pageReplay.session!.start_seconds, Number(slider!.min)) &&
            time < Math.min(bounds.end, pageReplay.session!.end_seconds, Number(slider!.max)) - 0.05,
        );
    });
    assert(targets.length >= 2);
    for (const time of targets) {
      await page
        .locator('#scrub-preview')
        .evaluate((p: HTMLElementTagNameMap['printer-scrub-preview'], value) => p.showPoint({ value }), time);
      await page.waitForFunction((value) => {
        const p = document.querySelector<HTMLElementTagNameMap['printer-scrub-preview']>('#scrub-preview');
        return !p!.hidden && p!.painted && p!.displayed!.time === value;
      }, time);
    }
    await page.waitForTimeout(1800);
    assert.equal(previews.length, 0, 'Already-decoded footage must never need the server preview endpoint.');
    assert.equal(
      await page.evaluate(async (original) => {
        const app = await import('/static/player.js');
        return (
          app.video === original.video &&
          app.hls === original.hls &&
          app.pageReplay.session!.session_id === original.session &&
          Math.abs(app.video.currentTime - original.time) < 0.1
        );
      }, original),
      true,
    );
    assert.equal(await page.locator('video').count(), 1);
    assert.equal(await page.locator('#scrub-preview .loader').count(), 0);
    const dimensions = await page
      .locator('#scrub-preview canvas')
      .evaluate((canvas: HTMLCanvasElement) => [canvas.width, canvas.height]);
    assert.deepEqual(dimensions, [320, 180]);
    assert.match((await page.locator('.scrub-preview-time').textContent()!)!, /^−\d+:\d{2}(?::\d{2})?$/);
    const frame = await page.locator('.scrub-preview-frame').boundingBox(),
      clock = await page.locator('.scrub-preview-time').boundingBox();
    assert(clock!.y >= frame!.y + frame!.height + 5);
    if (process.env.SCREENSHOT_DIR)
      await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/live-${name}.png` });
    const stored = await page.evaluate(async () => {
      const app = await import('/static/player.js');
      await Promise.all([...app.previewHistory.writes]);
      const key = app.previewHistory.frames.values().next().value!.asset;
      const row = await app.previewHistory.disk!.get(app.previewHistory.token!, key);
      return Boolean(row?.blob?.size);
    });
    assert.equal(stored, true);
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
      const keys = await caches.keys();
      const requests = (
        await Promise.all(keys.map(async (key) => await (await caches.open(key)).keys()))
      ).flat();
      const worker = await (await fetch('/service-worker.js')).text();
      if (/(?:const|let|var) cacheEnabled = false;/.test(worker) && requests.length)
        throw new Error('Development shell caching must stay disabled.');
      if (requests.some((request) => /\/(replay|api)\//.test(new URL(request.url).pathname)))
        throw new Error('Media entered the PWA cache.');
    });
    await page.mouse.move(10, 10);
    await page.getByRole('button', { name: 'Return to live video', exact: true }).click();
    await page.waitForFunction(
      () =>
        !document.querySelector<HTMLVideoElement>('video')!.paused &&
        document.querySelector<HTMLButtonElement>('#live-button')!.classList.contains('at-live'),
    );
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({
        browser: name,
        https: true,
        resolution: await page
          .locator('video')
          .evaluate((v: HTMLVideoElement) => `${v.videoWidth}x${v.videoHeight}`),
        capturedFrames: targets.length,
        previewHttp: 0,
        localIndexedDB: stored,
        spinner: false,
        clockBelow: true,
        sameSessionAndDecoder: true,
        liveResume: true,
        pwaDevelopmentCachingDisabled: true,
      }),
    );
    await page.evaluate(async () => (await import('/static/player.js')).pageReplay.close());
  } catch (error) {
    console.error(
      name,
      error instanceof Error ? error.message : String(error),
      await page
        .evaluate(async () => {
          const app = await import('/static/player.js'),
            p = document.querySelector<HTMLElementTagNameMap['printer-scrub-preview']>('#scrub-preview');
          return {
            point: p!.point,
            displayed: p!.displayed,
            hidden: p!.hidden,
            frames: [...app.previewHistory.frames.values()].map((frame) => frame.time),
            start: app.pageReplay.session?.start_seconds,
            end: app.pageReplay.session?.end_seconds,
            bounds: app.pageReplay.bounds(),
            range: [p!.slider.min, p!.slider.max],
            previews: app.previewHistory.diagnostics(),
          };
        })
        .catch(() => null),
    );
    throw error;
  } finally {
    await browser.close();
  }
}
