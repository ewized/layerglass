import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { waitForPlayer } from './player-page.js';

const base = process.env.VIEWER_URL || 'http://127.0.0.1:8080';
for (const [name, engine] of Object.entries({ chromium, webkit })) {
  const browser = await engine.launch({ headless: true, args: name === 'chromium' ? ['--no-sandbox'] : [] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, serviceWorkers: 'block' });
  const page = await context.newPage(), errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.url().includes('/preview.jpg?')) requests.push(request.url()); });
  try {
    await page.goto(base);
    await waitForPlayer(page, ({ app }) => app.video.videoWidth > 0 && !app.video.paused &&
      app.pageReplay.session?.end_seconds >= 36, undefined, { timeout: 60000 });
    assert.equal(requests.length, 0);
    await page.mouse.move(10, 10);
    await page.getByRole('button', { name: 'Pause video', exact: true }).click();
    await page.waitForTimeout(400);
    const pausedAt = await page.locator('video').evaluate(video => video.currentTime);
    // This test deliberately discards browser captures to exercise the real
    // server backup endpoint. The local-history test checks the normal path.
    await page.evaluate(async () => {
      const app = await import('/static/player.js');
      document.querySelector('#scrub-preview').configure(() => app.pageReplay);
      window.previewSeeks = 0;
      app.video.addEventListener('seeking', () => window.previewSeeks++);
    });
    const preview = page.locator('#scrub-preview'), slider = page.locator('#replay-slider');
    let box = await slider.boundingBox();
    const move = async fraction => page.mouse.move(box.x + 8 + (box.width - 16) * fraction, box.y + box.height / 2);
    const loaded = () => page.waitForFunction(() => {
      const p = document.querySelector('#scrub-preview');
      return !p.hidden && p.painted && p.displayed.asset && Math.abs(p.displayed.time - p.point.time) <= 5;
    });
    const inside = async () => {
      const rect = await preview.boundingBox(), player = await page.locator('#player').boundingBox();
      assert(rect.x >= player.x && rect.x + rect.width <= player.x + player.width + 1);
      assert(rect.y > player.y && rect.y + rect.height < box.y);
      const frame = await preview.locator('.scrub-preview-frame').boundingBox(), clock = await preview.locator('.scrub-preview-time').boundingBox();
      assert(clock.y >= frame.y + frame.height + 5);
    };
    await move(0.4); await loaded();
    assert.equal(requests.length, 1);
    assert.equal(await preview.locator('.loader').count(), 0);
    assert.match(await preview.locator('.scrub-preview-time').textContent(), /^−\d+:\d{2}(?::\d{2})?$/);
    await inside();
    const source = await preview.evaluate(p => p.displayed.asset);
    const range = await slider.evaluate(input => ({ min: Number(input.min), max: Number(input.max) }));
    for (let index = 0; index < 6; index++) {
      await move((index * 5 + 1 - range.min) / (range.max - range.min)); await loaded();
      assert.equal(await preview.evaluate(p => p.displayed.cell), index);
      assert.equal(await preview.evaluate(p => p.displayed.asset), source);
    }
    assert.equal(requests.length, 1, 'All six cells crop the same decoded sprite.');
    await page.waitForTimeout(1800);
    assert.equal(requests.length, 1, 'Stationary hover does not poll.');
    assert.equal(await page.evaluate(() => window.previewSeeks), 0);
    assert(Math.abs(await page.locator('video').evaluate(v => v.currentTime) - pausedAt) < 0.1);
    assert.equal(await page.locator('video').count(), 1);
    await page.mouse.move(10, 10);
    assert.equal(await preview.isVisible(), false);
    await move(0.4); await loaded(); assert.equal(requests.length, 1);
    for (const fraction of [0, 1]) { await move(fraction); await loaded(); await inside(); }

    await page.mouse.move(10, 10); await slider.focus(); await page.keyboard.press('Home'); await loaded();
    assert.equal(await preview.evaluate(p => p.point.time), 0);
    await slider.evaluate(input => input.blur());
    assert.equal(await preview.isVisible(), false);
    if (name === 'chromium') {
      const touch = await context.newCDPSession(page);
      await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + box.width * 0.35, y: box.y + box.height / 2, id: 1 }] });
      await loaded();
      await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: box.x + box.width * 0.65, y: box.y + box.height / 2, id: 1 }] });
      await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else {
      await slider.dispatchEvent('pointerdown', { pointerType: 'touch', pointerId: 8, isPrimary: true, clientX: box.x + box.width * 0.35 });
      await loaded();
      await slider.evaluate(input => input.dispatchEvent(new PointerEvent('pointercancel', { pointerType: 'touch', pointerId: 8, bubbles: true })));
    }
    assert.equal(await preview.isVisible(), false);
    for (const viewport of [{ width: 320, height: 568 }, { width: 844, height: 390 }]) {
      await page.setViewportSize(viewport); await page.mouse.move(10, 10); box = await slider.boundingBox();
      await move(0.5); await loaded(); await inside();
    }
    await preview.evaluate(p => {
      p.history.setSession(null); p.reset();
      if (!p.hidden || p.bitmapBytes || p.request || p.clockTimer) throw new Error('Preview resources leaked.');
    });
    await page.evaluate(async () => (await import('/static/player.js')).pageReplay.close());
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ browser: name, realBackupEndpoint: true, requests: requests.length, oneSpriteSixCells: true,
      noPolling: true, noMainVideoSeek: true, noSecondDecoder: true, keyboard: true, touch: true, clockBelow: true,
      mobileAndLandscapeBounds: true, cleanup: true }));
  } finally { await browser.close(); }
}
