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
    const body = await readFile(file);
    response.writeHead(200, { 'Content-Type': 'text/javascript' }); response.end(body);
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
      const jpeg = Buffer.from(await page.evaluate(async () => {
        const canvas = document.createElement('canvas'); canvas.width = 960; canvas.height = 360;
        const ctx = canvas.getContext('2d'); ctx.fillStyle = '#20a060'; ctx.fillRect(0, 0, 960, 360);
        window.previewJpeg = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg'));
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

      await page.unroute('**/replay/*/preview.jpg?*');
      const beforeDiskRequests = requests.length;
      await page.route('**/replay/*/preview.jpg?*', route => { requests.push(route.request().url()); return route.abort(); });
      await page.evaluate(async () => {
        const { PreviewHistory } = await import('/static/preview-history.js');
        window.persistedPreview = async token => {
          const history = new PreviewHistory({ maxBytes: 1 });
          const fixture = configurePreview(token, history);
          fixture.replay.session.preview_fallback = false;
          for (const time of [10, 70]) history.addFrame(time, previewJpeg);
          await Promise.all([...history.writes]);
          if (!history.assets.get('frame:10')?.persisted || history.bytes) throw new Error('Fixture JPEG was not persisted and evicted.');
          const get = history.disk.get.bind(history.disk);
          fixture.releases = new Map(); fixture.reads = [];
          history.disk.get = async (session, key) => {
            fixture.reads.push(key);
            const stored = await get(session, key);
            await new Promise(resolve => fixture.releases.set(key, resolve));
            return stored;
          };
          fixture.release = key => { fixture.releases.get(key)(); fixture.releases.delete(key); };
          return fixture;
        };
        window.clearPersistedPreview = async fixture => {
          const token = fixture.history.token;
          fixture.history.setSession(null);
          await fixture.history.disk.removeSession(token);
        };
        (await persistedPreview('late-read')).preview.showPoint({ value: 10 });
      });
      const timedOutRead = async key => {
        await page.waitForFunction(key => previewTest.releases.has(key), key);
        await page.waitForFunction(() => !previewTest.preview.resolving);
      };
      const painted = time => page.waitForFunction(time => previewTest.preview.displayed?.time === time, time, { timeout: 5000 });
      await timedOutRead('frame:10');
      await page.evaluate(() => previewTest.release('frame:10'));
      await painted(10);
      assert.equal(await page.evaluate(() => previewTest.history.bytes), 0, 'A late paint must also work when the JPEG cannot stay in RAM.');

      await page.evaluate(async () => {
        await clearPersistedPreview(previewTest);
        (await persistedPreview('different-target')).preview.showPoint({ value: 10 });
      });
      await timedOutRead('frame:10');
      await page.evaluate(() => previewTest.preview.showPoint({ value: 70 }));
      await page.waitForFunction(() => previewTest.releases.has('frame:70'));
      await page.evaluate(() => previewTest.release('frame:10'));
      await page.waitForTimeout(50);
      assert.equal(await page.evaluate(() => previewTest.preview.bitmaps.has('frame:10')), false, 'A late old target must not start decoding.');
      await timedOutRead('frame:70');
      await page.evaluate(() => previewTest.release('frame:70'));
      await painted(70);

      await page.evaluate(async () => {
        await clearPersistedPreview(previewTest);
        (await persistedPreview('old-disk-session')).preview.showPoint({ value: 10 });
      });
      await timedOutRead('frame:10');
      await page.evaluate(() => {
        window.oldPreviewTest = previewTest;
        const { preview, history, replay } = configurePreview('replacement-session');
        replay.session.preview_fallback = false;
        history.addFrame(70, previewJpeg); preview.showPoint({ value: 70 });
      });
      await painted(70);
      await page.evaluate(() => oldPreviewTest.release('frame:10'));
      await page.waitForTimeout(50);
      assert.equal(await page.evaluate(() => previewTest.preview.displayed.time), 70);
      assert.equal(await page.evaluate(() => previewTest.preview.bitmaps.has('frame:10')), false, 'An old session must not decode into its replacement.');

      await page.evaluate(async () => {
        await clearPersistedPreview(oldPreviewTest);
        (await persistedPreview('hidden-disk-read')).preview.showPoint({ value: 10 });
      });
      await timedOutRead('frame:10');
      await page.evaluate(() => { previewTest.preview.hide(); previewTest.release('frame:10'); });
      await page.waitForTimeout(50);
      assert.equal(await page.evaluate(() => previewTest.preview.bitmaps.size), 0, 'A hidden preview must not decode its late completion.');
      assert.equal(await page.evaluate(() => previewTest.preview.painted), false);

      await page.evaluate(async () => {
        await clearPersistedPreview(previewTest);
        (await persistedPreview('coalesced-disk-read')).preview.showPoint({ value: 10 });
      });
      await timedOutRead('frame:10');
      await page.evaluate(() => {
        window.previewDecodes = 0;
        if (typeof createImageBitmap === 'function') {
          const decode = window.createImageBitmap.bind(window);
          window.createImageBitmap = (...args) => { window.previewDecodes++; return decode(...args); };
        } else {
          const decode = HTMLImageElement.prototype.decode;
          HTMLImageElement.prototype.decode = function() { window.previewDecodes++; return decode.call(this); };
        }
        // A second resolution shares the same disk read. Its completion must
        // retain ownership of the decode lane when the first read arrives late.
        previewTest.preview.showPoint({ value: 10 });
        previewTest.release('frame:10');
      });
      await painted(10);
      await page.waitForFunction(() => !previewTest.preview.resolving);
      assert.deepEqual(await page.evaluate(() => ({ reads: previewTest.reads.length, decodes: previewDecodes })), { reads: 1, decodes: 1 });
      assert.equal(requests.length, beforeDiskRequests, 'Late local reads in browser-only mode must not fetch a sprite.');
      assert(await page.evaluate(() => previewTest.preview.bitmapBytes <= 8 * 1024 * 1024));
      assert.deepEqual(await page.evaluate(() => ({ video: document.querySelector('video') === originalVideo,
        count: document.querySelectorAll('video').length, seeks: previewSeeks })), { video: true, count: 1, seeks: 0 });
      await page.evaluate(async () => { await clearPersistedPreview(previewTest); previewTest.preview.reset(); });

      const nearest = await page.evaluate(async () => {
        const { PreviewHistory } = await import('/static/preview-history.js');
        const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
        const ctx = canvas.getContext('2d'), colors = ['#ff0000', '#0000ff', '#00ff00'], blobs = [];
        for (const color of colors) {
          ctx.fillStyle = color; ctx.fillRect(0, 0, 320, 180);
          blobs.push(await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg')));
        }
        const wait = async (predicate, detail) => {
          const deadline = performance.now() + 3000;
          while (!predicate()) {
            if (performance.now() > deadline) throw new Error('Closest preview did not resolve: ' + detail);
            await new Promise(requestAnimationFrame);
          }
        };
        const pixel = preview => [...preview.context.getImageData(160, 90, 1, 1).data];
        const adjacent = [];
        for (const [warm, cold, held] of [[20.133333, 25.066666, true], [25.066666, 20.133333, false]]) {
          const history = new PreviewHistory({ maxBytes: 1 });
          const fixture = configurePreview('adjacent-' + warm, history), { preview, replay } = fixture;
          replay.session.preview_fallback = false;
          for (const [time, blob] of [[20.133333, blobs[0]], [25.066666, blobs[1]]]) {
            history.addFrame(time, blob); await Promise.all([...history.writes]);
          }
          if (history.bytes || [...history.assets.values()].some(asset => !asset.persisted)) throw new Error('Expected cold IDB assets.');
          history.maxBytes = blobs[0].size + blobs[1].size;
          const reads = [], get = history.disk.get.bind(history.disk);
          let release;
          history.disk.get = async (...args) => {
            reads.push(args[1]);
            const stored = await get(...args);
            if (held && args[1] === 'frame:25') await new Promise(resolve => { release = resolve; });
            return stored;
          };
          await history.get(warm);
          preview.showPoint({ value: warm });
          await wait(() => preview.displayed?.time === warm, 'warm placeholder');
          const before = { nearest: history.nearest(cold).frame.time, placeholder: history.peek(cold).frame.time };
          preview.showPoint({ value: cold });
          let delayedPlaceholder;
          if (held) {
            await wait(() => release && !preview.resolving, 'held IDB deadline');
            delayedPlaceholder = preview.displayed.time;
            release();
          }
          // No second pointer event: the current read must paint the true target.
          await wait(() => preview.displayed?.time === cold, 'cold target ' + cold);
          adjacent.push({ warm, cold, held, before, delayedPlaceholder, displayed: preview.displayed.time,
            pixel: pixel(preview), reads, warmStillResident: Boolean(history.assets.get('frame:' + Math.floor(warm / 5) * 5).blob),
            bytes: history.bytes, limit: history.maxBytes, decodedBytes: preview.bitmapBytes });
          await clearPersistedPreview(fixture); preview.reset();
        }

        const history = new PreviewHistory({ maxBytes: 1 });
        const fixture = configurePreview('contiguous-cold-sweep', history), { preview, replay } = fixture;
        replay.session.preview_fallback = false;
        const times = Array.from({ length: 12 }, (_, index) => 20 + index * 5 + (index % 2 ? 0.066666 : 0.133333));
        for (const [index, time] of times.entries()) {
          history.addFrame(time, blobs[index % blobs.length]); await Promise.all([...history.writes]);
        }
        if (history.bytes || [...history.assets.values()].some(asset => !asset.persisted)) throw new Error('Sweep must begin in IDB.');
        history.maxBytes = Math.max(...blobs.map(blob => blob.size));
        const reads = [], get = history.disk.get.bind(history.disk), sweep = [];
        history.disk.get = async (...args) => { reads.push(args[1]); return get(...args); };
        for (const direction of [times, [...times].reverse()]) {
          preview.reset(); // Avoid decoded cache hits hiding RAM/IDB selection on return.
          for (const time of direction) {
            preview.showPoint({ value: time });
            await wait(() => preview.displayed?.time === time, 'contiguous target ' + time);
            sweep.push({ time, pixel: pixel(preview), color: times.indexOf(time) % blobs.length,
              bytes: history.bytes, limit: history.maxBytes, decodedBytes: preview.bitmapBytes });
          }
        }
        const result = { adjacent, sweep, reads: reads.length, pending: history.pending.size };
        await clearPersistedPreview(fixture); preview.reset();
        return result;
      });
      for (const entry of nearest.adjacent) {
        assert.deepEqual(entry.before, { nearest: entry.cold, placeholder: entry.warm });
        if (entry.held) assert.equal(entry.delayedPlaceholder, entry.warm);
        assert.equal(entry.displayed, entry.cold);
        assert.deepEqual(entry.reads, [entry.warm, entry.cold].map(time => 'frame:' + Math.floor(time / 5) * 5));
        assert(entry.pixel[entry.cold > entry.warm ? 2 : 0] > 240);
        assert(entry.warmStillResident, 'Resolution must not require evicting the warm neighbor.');
        assert(entry.bytes <= entry.limit && entry.decodedBytes <= 8 * 1024 * 1024);
      }
      assert.equal(nearest.sweep.length, 24);
      for (const entry of nearest.sweep) {
        assert(entry.pixel[[0, 2, 1][entry.color]] > 240);
        assert(entry.bytes <= entry.limit && entry.decodedBytes <= 8 * 1024 * 1024);
      }
      assert(nearest.reads >= 12 && nearest.reads <= 24);
      assert.equal(nearest.pending, 0);
      assert.equal(requests.length, beforeDiskRequests, 'Closest local frames must not request server sprites.');
      assert.deepEqual(await page.evaluate(() => ({ video: document.querySelector('video') === originalVideo,
        count: document.querySelectorAll('video').length, seeks: previewSeeks })), { video: true, count: 1, seeks: 0 });
      assert.deepEqual(errors, []);
      console.log(`${name}: corrupt sprite cooldown, valid retry, local fallback and cancelled response passed.`);
      console.log(`${name}: late persisted reads, target/session/visibility ownership and coalesced decoding passed.`);
      console.log(`${name}: closest cold frames replace warm neighbors in both directions; 24 contiguous retained stills paint within cache bounds, ${nearest.reads} IDB reads, no server requests or main seeks.`);
    } finally { await context.close(); await browser.close(); }
  }
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
