import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';

// Isolated component fixture: real JPEG decoding, no camera, stream or app startup.
const source = new URL('../src/', import.meta.url);
const html = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
  <video></video><div><input type="range" min="0" max="120" style="width:320px">
  <printer-scrub-preview></printer-scrub-preview></div><script type="module">
  import { PrinterScrubPreview } from '/static/components/scrub-preview.js';
  import { PreviewHistory } from '/static/preview-history.js';
  customElements.define('printer-scrub-preview', PrinterScrubPreview);
  const preview = document.querySelector('printer-scrub-preview');
  window.configurePreview = (token, history = new PreviewHistory({ disk: null })) => {
    const session = { session_id: token, ready: true, start_seconds: 0, end_seconds: 120 };
    const replay = { session, backend: { id: 'python' }, timeline: { edge: 120 },
      bounds: () => ({ start: 0, end: 120 }) };
    preview.configure(() => replay, history);
    preview.slider.min = 0; preview.slider.max = 120; preview.slider.disabled = false;
    return window.previewTest = { preview, history, replay };
  };
  window.previewClock = Date.now(); Date.now = () => window.previewClock;
  window.originalVideo = document.querySelector('video');
  window.previewSeeks = 0;
  window.originalVideo.addEventListener('seeking', () => window.previewSeeks++);
  window.previewReady = true;
  </script>`;
const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://fixture.invalid').pathname;
  if (path === '/') {
    response.writeHead(200, { 'Content-Type': 'text/html' }); response.end(html); return;
  }
  const file = path.startsWith('/static/') && new URL(path.slice('/static/'.length), source);
  if (!file || !file.href.startsWith(source.href)) { response.writeHead(404).end(); return; }
  try {
    response.writeHead(200, { 'Content-Type': 'text/javascript' }); response.end(await readFile(file));
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

try {
  for (const [name, engine] of Object.entries({ chromium, webkit })) {
    const browser = await engine.launch({ headless: true, args: name === 'chromium' ? ['--no-sandbox'] : [] });
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.route(url => url.origin !== base, route => route.abort());
    await context.addInitScript(() => Object.defineProperty(navigator, 'onLine', { get: () => true }));
    const page = await context.newPage(), errors = [], requests = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
      await page.goto(base);
      await page.waitForFunction(() => window.previewReady);
      const jpeg = Buffer.from(await page.evaluate(() => {
        const canvas = document.createElement('canvas'); canvas.width = 960; canvas.height = 360;
        const ctx = canvas.getContext('2d'); ctx.fillStyle = '#20a060'; ctx.fillRect(0, 0, 960, 360);
        return canvas.toDataURL('image/jpeg').split(',')[1];
      }), 'base64');
      let corrupt = true;
      await page.route('**/replay/*/preview.jpg?*', route => {
        requests.push(route.request().url());
        return route.fulfill({ status: 200, contentType: 'image/jpeg', body: corrupt ? Buffer.from('invalid JPEG') : jpeg });
      });
      await page.evaluate(() => configurePreview('corrupt-sprite').preview.showPoint({ value: 10 }));
      await page.waitForFunction(() => previewTest.preview.failures.has('decode:sheet:0:6') && !previewTest.preview.resolving);
      await page.waitForTimeout(550);
      assert.equal(requests.length, 1, `${name}: a failed sprite decode must not start an HTTP retry loop.`);
      assert.equal(await page.evaluate(() => previewTest.preview.painted), false);
      corrupt = false;
      await page.evaluate(() => { window.previewClock += 10001; previewTest.preview.showPoint({ value: 10 }); });
      await page.waitForFunction(() => previewTest.preview.displayed?.time === 10);
      assert.equal(requests.length, 2, 'A deliberate retry after the cooldown can use a valid replacement.');

      await page.evaluate(() => {
        const { preview, history } = configurePreview('corrupt-capture');
        history.addFrame(10, new Blob(['invalid captured JPEG'], { type: 'image/jpeg' }));
        preview.showPoint({ value: 10 });
      });
      await page.waitForFunction(() => previewTest.preview.displayed?.asset === 'sheet:0:6');
      assert.equal(requests.length, 3, 'A corrupt capture must still use a different server sprite.');
      assert.equal(await page.evaluate(() => previewTest.preview.failures.has('decode:frame:10')), true);
      const pixel = await page.evaluate(() => [...previewTest.preview.context.getImageData(160, 90, 1, 1).data]);
      assert(Math.abs(pixel[0] - 32) < 5 && Math.abs(pixel[1] - 160) < 5);

      // A response whose owner was hidden/reset must not populate the next page.
      await page.unroute('**/replay/*/preview.jpg?*');
      let release;
      await page.route('**/replay/*/preview.jpg?*', async route => {
        requests.push(route.request().url());
        await new Promise(resolve => { release = resolve; });
        await route.fulfill({ status: 200, contentType: 'image/jpeg', body: jpeg }).catch(() => {});
      });
      await page.evaluate(() => configurePreview('cancelled-sprite').preview.showPoint({ value: 10 }));
      await page.waitForFunction(() => Boolean(previewTest.preview.request));
      for (let attempt = 0; !release && attempt < 50; attempt++) await page.waitForTimeout(10);
      assert(release);
      await page.evaluate(() => { const { preview, replay } = configurePreview('new-page'); replay.session.preview_fallback = false; preview.showPoint({ value: 70 }); });
      release();
      await page.waitForTimeout(200);
      assert.equal(await page.evaluate(() => previewTest.history.frames.size), 0);
      assert.equal(await page.evaluate(() => previewTest.preview.painted), false);
      assert.deepEqual(await page.evaluate(() => ({ video: document.querySelector('video') === originalVideo,
        count: document.querySelectorAll('video').length, seeks: previewSeeks })), { video: true, count: 1, seeks: 0 });
      await page.evaluate(() => { previewTest.history.setSession(null); previewTest.preview.reset(); });
      assert.deepEqual(errors, []);
      console.log(`${name}: corrupt sprite cooldown, valid retry, local fallback and cancelled response passed.`);
    } finally { await context.close(); await browser.close(); }
  }
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
