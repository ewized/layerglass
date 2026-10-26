import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';

const base = process.env.VIEWER_URL;
assert(base?.startsWith('https://'));
await Promise.all(
  Object.entries({ chromium, webkit }).map(async ([name, engine]) => {
    const browser = await engine.launch({
      headless: true,
      args: name === 'chromium' ? ['--no-sandbox'] : [],
    });
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const errors: Array<string> = [];
    page.on('pageerror', (error) => errors.push(error.message));
    try {
      await page.goto(base!);
      await page.waitForFunction(
        () => {
          const video = document.querySelector<HTMLVideoElement>('video');
          return (
            video!.videoWidth > 0 &&
            !video!.paused &&
            video!.currentTime > 1 &&
            document.querySelector<HTMLElementTagNameMap['printer-loading']>('#overlay')!.hidden
          );
        },
        undefined,
        { timeout: 45000 },
      );
      await page.mouse.move(12, 12);
      await page.locator('#options-button').click();
      await page.locator('#printers-button').click();
      assert((await page.locator('printer-item').count()) > 0);
      const progress = await page.evaluate(async () => {
        const response = await fetch('/api/cameras');
        const scan = (await response.json()).discovery;
        return {
          state: scan.state,
          checked: scan.checked,
          total: scan.total,
          cached: scan.cached,
          probed: scan.probed,
        };
      });
      assert(Number.isFinite(progress.cached) && Number.isFinite(progress.probed));
      assert.equal(await page.locator('video').evaluate((video: HTMLVideoElement) => video.paused), false);
      assert.deepEqual(errors, []);
      console.log(
        JSON.stringify({
          browser: name,
          https: true,
          printerList: true,
          resolution: await page
            .locator('video')
            .evaluate((video: HTMLVideoElement) => `${video.videoWidth}x${video.videoHeight}`),
          discovery: progress,
        }),
      );
    } finally {
      await browser.close();
    }
  }),
);
