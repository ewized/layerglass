import assert from 'node:assert/strict';
import { chromium } from 'playwright';

(async () => {
  const base = process.env.VIEWER_URL || 'http://192.168.50.50:8099';
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
    const failures: Array<string> = [];
    const external: Array<string> = [];
    page.on('pageerror', (error) => failures.push(error.message));
    page.on('request', (request) => {
      const url = request.url();
      if (url.startsWith('http') && new URL(url).origin !== new URL(base).origin) external.push(url);
    });
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () => {
        const v = document.querySelector<HTMLVideoElement>('video');
        return v!.videoWidth > 0 && v!.getVideoPlaybackQuality().totalVideoFrames > 5;
      },
      undefined,
      { timeout: 60000 },
    );
    assert.equal(await page.locator('#overlay').isVisible(), false);
    const dimensions = await page
      .locator('video')
      .evaluate((v: HTMLVideoElement) => [v.videoWidth, v.videoHeight]);
    await page.locator('#options-button').click();
    await page.getByRole('button', { name: 'Refresh viewer' }).click();
    await page.waitForFunction(
      () => document.querySelector<HTMLElementTagNameMap['printer-loading']>('#overlay')!.hidden,
      undefined,
      { timeout: 30000 },
    );
    const status = await (await page.request.get(`${base}/api/status`)).json();
    const previous = status.generation;
    await page.locator('#options-button').click();
    await page.getByRole('button', { name: 'Refresh viewer' }).click();
    await page.waitForFunction(
      async (old) => {
        const s = await (await fetch('/api/status')).json();
        return s.generation !== old && s.state === 'live';
      },
      previous,
      { timeout: 45000 },
    );
    await page.waitForFunction(
      () =>
        document.querySelector<HTMLElementTagNameMap['printer-loading']>('#overlay')!.hidden &&
        document.querySelector<HTMLVideoElement>('video')!.videoWidth > 0,
      undefined,
      { timeout: 45000 },
    );
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
      'Mobile layout overflows horizontally.',
    );
    assert.deepEqual(external, [], 'Player should not make external network requests.');
    assert.deepEqual(failures, [], 'Browser JavaScript errors.');
    const source = await page.content();
    assert.equal(source.includes('rtsps://'), false, 'Camera URL leaked into HTML.');
    console.log(
      JSON.stringify({
        playback: 'passed',
        dimensions,
        refresh: 'passed',
        relayRestart: 'passed',
        mobileLayout: 'passed',
        externalRequests: external.length,
        javascriptErrors: failures.length,
      }),
    );
    if (process.env.SCREENSHOT_PATH) {
      await page.setViewportSize({ width: 1280, height: 960 });
      await page.screenshot({ path: process.env.SCREENSHOT_PATH, fullPage: true });
    }
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
