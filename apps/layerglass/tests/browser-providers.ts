import type { BrowserType, Page } from 'playwright';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chromium, webkit } from 'playwright';
import type { CameraCatalog } from '../../backend-contracts/src/index.js';

const base = process.env.VIEWER_URL;

async function ready(page: Page) {
  await page.waitForFunction(
    () =>
      (document.querySelector<HTMLVideoElement>('video')?.videoWidth ?? Number.NaN) > 0 &&
      !document.querySelector<HTMLVideoElement>('video')!.paused &&
      document.querySelector<HTMLElementTagNameMap['printer-loading']>('#overlay')!.hidden,
    undefined,
    { timeout: 45000 },
  );
}

async function check(name: string, engine: BrowserType) {
  const browser = await engine.launch({ headless: true, args: name === 'chromium' ? ['--no-sandbox'] : [] });
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const errors: Array<unknown> = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.addInitScript(() => {
      try {
        localStorage.setItem('bambu-camera', 'outdated-device-selection');
      } catch (_) {}
    });
    await page.goto(base!);
    await ready(page);
    assert.equal(await page.title(), 'Printer camera');
    assert.equal(await page.locator('printer-player').count(), 1);
    assert.equal(await page.locator('[class*="Bambu"], bambu-player').count(), 0);
    assert.equal(await page.evaluate(() => localStorage.getItem('bambu-camera')), null);
    assert(await page.evaluate(() => localStorage.getItem('printer-camera')));
    const session = await page.evaluate(
      async () => (await import('/static/player.js')).pageReplay.session!.session_id,
    );
    await page.locator('#options-button').click();
    await page.locator('#printers-button').click();
    const catalog: CameraCatalog = await (await page.request.get(`${base}/api/cameras`)).json();
    assert.equal(catalog.cameras.length, 2, 'Raw generic fixtures must never reach the public catalog.');
    assert(
      catalog.cameras.every((camera) => camera.provider === 'bambu' && camera.setup?.type === 'access_code'),
    );
    assert.equal(await page.locator('printer-item').count(), 2);
    assert.equal(
      await page.locator('input[name="path"], input[name="username"], input[name="password"]').count(),
      0,
    );
    const cameraName = 'Studio X1';
    const row = page
      .locator('printer-item')
      .filter({ has: page.locator('.printer-name', { hasText: cameraName }) });
    assert(
      await row.locator('.printer-code-form').isHidden(),
      'Entering Printers must not force the access-code editor open.',
    );
    await row.locator('.printer-access').click();
    assert.equal(
      await row.locator('.printer-code-form').getAttribute('aria-label'),
      `Access code for ${cameraName}`,
    );
    assert.equal(await row.locator('input[name="access-code"]').getAttribute('type'), 'text');
    await row.locator('input[name="access-code"]').fill('draft-code');
    assert.equal(
      await page.evaluate(async () => (await import('/static/player.js')).pageReplay.session!.session_id),
      session,
    );
    for (const candidate of ['192.168.50.8:8554:rtsp', '192.168.50.10:8080:http']) {
      const id = createHash('sha256').update(candidate).digest('hex').slice(0, 16);
      const response = await page.request.post(`${base}/api/cameras/${id}/configure`, {
        headers: { 'X-Viewer-Request': '1' },
        data: { path: '/custom', username: 'viewer', password: 'test-code' },
      });
      assert.equal(
        response.status(),
        400,
        'Direct generic pairing attempts must also be rejected by the server.',
      );
    }
    const configured = catalog.cameras.find((camera) => camera.configured)!;
    const response = await page.request.post(`${base}/api/cameras/${configured.id}/configure`, {
      headers: { 'X-Viewer-Request': '1' },
      data: { access_code: 'test-code', path: '/custom' },
    });
    assert.equal(response.status(), 400, 'A valid printer must not allow arbitrary stream paths.');
    assert.equal(await row.locator('input[name="access-code"]').inputValue(), 'draft-code');
    assert.equal(await page.locator('#camera-name').textContent(), 'Bambu Lab X2D');
    assert.equal(
      await page.evaluate(async () => (await import('/static/player.js')).pageReplay.session!.session_id),
      session,
    );
    if (process.env.SCREENSHOT_DIR)
      await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/${name}-approved-printers.png` });
    assert.deepEqual(errors, []);
    console.log(
      `${name}: approved printers only, code-only inline pairing, generic API rejection, approved stream path enforcement, draft and active playback preservation passed`,
    );
    await page.goto('about:blank');
  } catch (error) {
    if (process.env.SCREENSHOT_DIR)
      await page
        .screenshot({ path: `${process.env.SCREENSHOT_DIR}/${name}-providers-failure.png` })
        .catch(() => {});
    throw error;
  } finally {
    await browser.close();
  }
}

await Promise.all([check('chromium', chromium), check('webkit', webkit)]);
