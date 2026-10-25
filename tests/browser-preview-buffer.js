import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { waitForPlayer } from './player-page.js';

const base = process.env.VIEWER_URL || 'http://127.0.0.1:8080';

for (const [name, engine] of Object.entries({ chromium, webkit })) {
  const browser = await engine.launch({ headless: true, args: name === 'chromium' ? ['--no-sandbox'] : [] });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const errors = [], requests = [], streams = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (request.url().includes('/preview.jpg?')) requests.push(request.url());
    if (/\/video(?:\?|$)/.test(request.url())) streams.push(request.url());
  });
  try {
    await page.goto(base);
    await waitForPlayer(page, ({ app }) => app.previewHistory.frames.size >= 4 &&
      app.video.videoWidth > 0 && !app.video.paused, undefined, { timeout: 45000 });
    assert.equal(requests.length, 0, 'Recording local stills must not fetch previews.');
    const real = await page.evaluate(async () => {
      const app = await import('/static/player.js');
      app.pageReplay.togglePause();
      app.previewCapture.cancel();
      window.originalVideo = app.video;
      window.originalHls = app.hls;
      window.previewSeeks = 0;
      app.video.addEventListener('seeking', () => window.previewSeeks++);
      const frame = [...app.previewHistory.frames.values()][1];
      document.querySelector('#scrub-preview').showPoint({ value: frame.time });
      return { captured: app.previewHistory.captured, target: frame.time };
    });
    await page.waitForFunction(time => {
      const p = document.querySelector('#scrub-preview');
      return p.painted && p.displayed.time === time;
    }, real.target);
    assert.equal(requests.length, 0);
    assert.equal(await page.locator('#scrub-preview .loader').count(), 0);
    assert.equal(await page.locator('video').count(), 1);
    assert.equal(await page.evaluate(async () => {
      const app = await import('/static/player.js');
      return app.video === window.originalVideo && app.hls === window.originalHls;
    }), true);

    // Simulate 45 minutes of already-decoded frames. Actual capture above uses
    // the running video; this accelerated part verifies full-session retention.
    const seeded = await page.evaluate(async () => {
      const app = await import('/static/player.js');
      app.previewCapture.close();
      const { PreviewHistory } = await import('/static/preview-history.js');
      const history = new PreviewHistory();
      const session = { session_id: '1'.repeat(32), ready: true, start_seconds: 0, end_seconds: 2700 };
      const p = document.querySelector('#scrub-preview');
      p.configure(() => ({ session, timeline: { edge: 2700 }, bounds: () => ({ start: 0, end: 2700 }) }), history);
      window.previewTestSession = session;
      const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
      const ctx = canvas.getContext('2d'), images = [];
      for (let color = 0; color < 16; color++) {
        ctx.fillStyle = `rgb(${color * 17}, 70, ${255 - color * 17})`; ctx.fillRect(0, 0, 320, 180);
        images.push(await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.6)));
      }
      for (let frame = 0; frame < 540; frame++) {
        history.addFrame(frame * 5 + 0.1, images[frame % 16]);
        if (history.writes.size >= 8) await Promise.all([...history.writes]);
      }
      await Promise.all([...history.writes]);
      p.slider.min = 0; p.slider.max = 2700;
      return history.diagnostics();
    });
    assert.equal(seeded.frames, 540);
    assert.equal(seeded.disk_available, true);
    const beforeStreams = streams.length;
    const sweep = await page.evaluate(async () => {
      const p = document.querySelector('#scrub-preview'), timings = [];
      for (let step = 0; step < 540; step++) {
        // A coprime stride jumps between old/new footage and covers every cell.
        const index = step * 137 % 540, time = index * 5 + 0.1, started = performance.now();
        p.slider.min = 0; p.slider.max = 2700;
        p.showPoint({ value: time });
        while (p.displayed?.time !== time) {
          if (performance.now() - started > 2000) throw new Error('Local preview did not render: ' + time);
          await new Promise(requestAnimationFrame);
        }
        const pixel = p.context.getImageData(160, 90, 1, 1).data;
        if (Math.abs(pixel[0] - index % 16 * 17) > 4 || Math.abs(pixel[2] - (255 - index % 16 * 17)) > 4) {
          throw new Error('Preview pixels do not match their recorded time.');
        }
        timings.push(performance.now() - started);
      }
      return { maxMs: Math.ceil(Math.max(...timings)), meanMs: Math.round(timings.reduce((a, b) => a + b) / timings.length),
        decodedBytes: p.bitmapBytes, diagnostics: p.history.diagnostics() };
    });
    assert.equal(requests.length, 0, 'Every five-second point across 45 minutes must render without HTTP.');
    assert.equal(streams.length, beforeStreams, 'Previewing must not restart the video stream.');
    assert.equal(await page.evaluate(() => window.previewSeeks), 0);
    assert(sweep.decodedBytes <= 8 * 1024 * 1024);
    assert(sweep.diagnostics.memory_bytes <= sweep.diagnostics.memory_limit);

    // Force RAM eviction. Read actual structured JPEG Blobs back from IndexedDB.
    const diskRead = await page.evaluate(async () => {
      const p = document.querySelector('#scrub-preview');
      p.hide(); p.reset(); p.history.maxBytes = 1; p.history.evict();
      const frame = await p.history.get(10.1);
      if (!frame?.asset.blob || frame.frame.time !== 10.1) throw new Error('Stored JPEG was not recovered.');
      p.slider.min = 0; p.slider.max = 2700; p.showPoint({ value: 10.1 });
      return p.history.diagnostics();
    });
    await page.waitForFunction(() => document.querySelector('#scrub-preview').displayed?.time === 10.1);
    assert(diskRead.disk_hits >= 1);
    assert.equal(requests.length, 0);

    // Simulate storage eviction/background footage. One server sprite fills a
    // missing interval; local images still work while that response is delayed.
    const sprite = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 960; canvas.height = 360;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#20a060'; ctx.fillRect(0, 0, 960, 360);
      return canvas.toDataURL('image/jpeg').split(',')[1];
    });
    let release;
    await page.route('**/preview.jpg?*', async route => {
      await new Promise(resolve => { release = resolve; });
      await route.fulfill({ status: 200, contentType: 'image/jpeg', body: Buffer.from(sprite, 'base64') }).catch(() => {});
    });
    await page.locator('#scrub-preview').evaluate(p => {
      for (let time = 890; time <= 930; time += 5) p.history.forgetFrame(time);
      p.history.maxBytes = 32 * 1024 * 1024;
      p.slider.min = 0; p.slider.max = 2700; p.showPoint({ value: 901 });
    });
    await page.waitForFunction(() => Boolean(document.querySelector('#scrub-preview').request));
    for (let step = 0; !release && step < 50; step++) await page.waitForTimeout(20);
    assert(release);
    await page.locator('#scrub-preview').evaluate(p => { p.slider.max = 2700; p.showPoint({ value: 10.1 }); });
    await page.waitForFunction(() => document.querySelector('#scrub-preview').displayed?.time === 10.1);
    release();
    await page.waitForFunction(() => !document.querySelector('#scrub-preview').request);
    assert.equal(await page.locator('#scrub-preview').evaluate(p => p.displayed.time), 10.1, 'Late replies cannot replace the current image.');
    await page.locator('#scrub-preview').evaluate(p => { p.slider.max = 2700; p.showPoint({ value: 901 }); });
    await page.waitForFunction(() => document.querySelector('#scrub-preview').displayed?.time === 900);
    assert.equal(requests.length, 1, 'The server backup is downloaded once and reused.');
    assert.match(await page.locator('.scrub-preview-time').textContent(), /^−30:00$/);
    const frame = await page.locator('.scrub-preview-frame').boundingBox();
    const clock = await page.locator('.scrub-preview-time').boundingBox();
    assert(clock.y >= frame.y + frame.height + 5);

    // Quota failure: recent stills remain available from bounded RAM.
    const quota = await page.evaluate(async () => {
      const { PreviewHistory } = await import('/static/preview-history.js');
      const { PreviewStorage } = await import('/static/preview-storage.js');
      const disk = new PreviewStorage({ factory: { open() { throw new DOMException('Denied', 'QuotaExceededError'); } } });
      const h = new PreviewHistory({ disk, maxBytes: 1024 }); h.setSession({ session_id: 'quota-test' });
      for (let i = 0; i < 100; i++) { h.addFrame(i * 5, new Blob([new Uint8Array(512)])); await Promise.all([...h.writes]); }
      return { count: h.frames.size, bytes: h.bytes, available: disk.available, recent: Boolean(h.peek(495)), old: Boolean(h.peek(0)) };
    });
    assert.deepEqual(quota, { count: 2, bytes: 1024, available: false, recent: true, old: false });
    await page.locator('#scrub-preview').evaluate(async p => {
      const token = p.history.token, disk = p.history.disk;
      p.history.setSession(null); p.reset();
      await disk.removeSession(token);
      if (await disk.get(token, 'frame:10')) throw new Error('Closed session retained thumbnails.');
      if (p.bitmapBytes || p.history.bytes || p.history.frames.size || p.request || p.clockTimer) throw new Error('Preview resources leaked.');
    });
    await page.evaluate(async () => (await import('/static/player.js')).pageReplay.close());
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ browser: name, capturedFromNativeVideo: real.captured, simulatedMinutes: 45, localFrames: 540,
      previewHttpDuringSweep: 0, ...sweep, diskRecovery: true, serverFallbackRequests: requests.length,
      quotaFallback: true, clockBelow: true, oneDecoder: true, sessionCleanup: true }));
  } finally { await browser.close(); }
}
