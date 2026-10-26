import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';

// Actual ReplayBuffer output: later page opened at 1020; fractional first capture,
// 1031.5 successor, 1035.000123 tail, then real byte pruning and 1036.25 capture.
// The upward payload is unchanged from the original recorder/IDB negative control.
const jpegBoundsMetadata = {
  first: {
    session_id: "701539b93b1e42c2ba51361c2ef6994a",
    camera_id: "1234567890abcdef",
    kind: "jpeg",
    playlist_url: null,
    video_url: null,
    frame_url: "/replay/701539b93b1e42c2ba51361c2ef6994a/frame.jpg",
    start_seconds: 10.124,
    end_seconds: 11.124,
    clock: [{"position":-20,"time":1000}],
    end_time: 1030.123678,
    ready: true,
    limited: false,
    error: null,
    jpeg_frame: {"sequence":1,"start":10.123677999999927,"position":10.123677999999927,"time":1030.123678,"clock":[{"position":-20,"time":1000}]},
  },
  upward: {
    session_id: "701539b93b1e42c2ba51361c2ef6994a",
    camera_id: "1234567890abcdef",
    kind: "jpeg",
    playlist_url: null,
    video_url: null,
    frame_url: "/replay/701539b93b1e42c2ba51361c2ef6994a/frame.jpg",
    start_seconds: 10.124,
    end_seconds: 12.5,
    clock: [{"position":-20,"time":1000}],
    end_time: 1031.5,
    ready: true,
    limited: false,
    error: null,
    jpeg_frame: {"sequence":2,"start":10.123677999999927,"position":11.5,"time":1031.5,"clock":[{"position":-20,"time":1000}]},
  },
  downward: {
    session_id: "86d16ee3cb374c679f9398e122125b27",
    camera_id: "1234567890abcdef",
    kind: "jpeg",
    playlist_url: null,
    video_url: null,
    frame_url: "/replay/86d16ee3cb374c679f9398e122125b27/frame.jpg",
    start_seconds: 10.123,
    end_seconds: 12.5,
    clock: [{"position":-20,"time":1000}],
    end_time: 1031.5,
    ready: true,
    limited: false,
    error: null,
    jpeg_frame: {"sequence":2,"start":10.123456000000033,"position":11.5,"time":1031.5,"clock":[{"position":-20,"time":1000}]},
  },
  tail: {
    session_id: "701539b93b1e42c2ba51361c2ef6994a",
    camera_id: "1234567890abcdef",
    kind: "jpeg",
    playlist_url: null,
    video_url: null,
    frame_url: "/replay/701539b93b1e42c2ba51361c2ef6994a/frame.jpg",
    start_seconds: 10.124,
    end_seconds: 16,
    clock: [{"position":-20,"time":1000}],
    end_time: 1035.000123,
    ready: true,
    limited: false,
    error: null,
    jpeg_frame: {"sequence":3,"start":10.123677999999927,"position":15.00012300000003,"time":1035.000123,"clock":[{"position":-20,"time":1000}]},
  },
  retained: {
    session_id: "701539b93b1e42c2ba51361c2ef6994a",
    camera_id: "1234567890abcdef",
    kind: "jpeg",
    playlist_url: null,
    video_url: null,
    frame_url: "/replay/701539b93b1e42c2ba51361c2ef6994a/frame.jpg",
    start_seconds: 15,
    end_seconds: 17.25,
    clock: [{"position":-20,"time":1000}],
    end_time: 1036.25,
    ready: true,
    limited: true,
    error: null,
    jpeg_frame: {"sequence":4,"start":15.00012300000003,"position":16.25,"time":1036.25,"clock":[{"position":-20,"time":1000}]},
  },
};

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

async function checkJpegBounds(page, jpeg, requests, name) {
  await page.unroute('**/replay/*/preview.jpg?*');
  const initialRequests = requests.length;
  await page.route('**/replay/*/preview.jpg?*', route => {
    requests.push(route.request().url());
    return route.fulfill({ status: 200, contentType: 'image/jpeg', body: jpeg });
  });
  await page.evaluate(async () => {
    const { PreviewHistory, PreviewCapture } = await import('/static/preview-history.js');
    const { PageReplay } = await import('/static/replay.js');
    const preview = document.querySelector('printer-scrub-preview'), video = originalVideo;
    window.closeJpegBounds = async () => {
      const fixture = window.jpegBounds;
      if (!fixture) return;
      fixture.capture.close(); preview.reset();
      const token = fixture.history.token;
      fixture.history.setSession(null);
      await fixture.history.disk.removeSession(token);
      if (fixture.url) URL.revokeObjectURL(fixture.url);
      fixture.image.remove(); window.jpegBounds = null;
    };
    window.setupJpegBounds = async (metadata, captureFrame = true) => {
      await closeJpegBounds();
      const session = structuredClone(metadata), precise = metadata.jpeg_frame.start;
      const image = document.createElement('img'); document.body.append(image);
      const history = new PreviewHistory({ maxBytes: captureFrame ? 1 : 32 * 1024 * 1024 });
      const replay = Object.assign(Object.create(PageReplay.prototype), { session, video, image, version: 0,
        backend: { id: 'python' }, paused: true, followLive: false, position: precise,
        imageFrame: null, imageLoading: false, timeline: { edge: session.end_seconds + 5 } });
      const capture = new PreviewCapture(history, video, image, () => replay);
      preview.configure(() => replay, history, capture);
      preview.slider.min = 0; preview.slider.max = 30; preview.slider.disabled = false;
      const fixture = window.jpegBounds = { preview, history, capture, replay, image, reads: [] };
      if (captureFrame) {
        const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
        const ctx = canvas.getContext('2d'); ctx.fillStyle = '#0000ff'; ctx.fillRect(0, 0, 320, 180);
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg'));
        fixture.url = URL.createObjectURL(blob); image.src = fixture.url; await image.decode();
        // This fixture publishes ownership only after native decode. Production
        // PageReplay descriptor/bounds/decodedImage and PreviewCapture do the rest.
        replay.imageFrame = { position: precise, time: metadata.clock[0].time + precise - metadata.clock[0].position,
          url: fixture.url, session: session.session_id, camera: session.camera_id, version: replay.version };
        image.dispatchEvent(new Event('replayimagechange'));
        const deadline = performance.now() + 3000;
        while (!history.assets.get('frame:10')?.persisted || history.writes.size) {
          if (performance.now() > deadline) throw new Error('Owned native JPEG did not persist');
          await new Promise(requestAnimationFrame);
        }
        fixture.before = { frame: { ...history.frames.get(10) }, cold: !history.assets.get('frame:10').blob,
          disk: Boolean(await history.disk.get(history.token, 'frame:10')), metadata: structuredClone(session) };
        // The one-byte budget only forces a cold initial read; normal fallback
        // and paint use the production RAM budget, as in the preserved control.
        history.maxBytes = 32 * 1024 * 1024;
      }
      const get = history.disk.get.bind(history.disk);
      history.disk.get = (...args) => { fixture.reads.push(args[1]); return get(...args); };
    };
    window.readJpegBounds = async () => {
      const { preview, history, replay, before, reads } = jpegBounds;
      return { before, metadata: structuredClone(replay.session), point: preview.point?.time,
        sheet: preview.sheet, displayed: preview.displayed, hidden: preview.hidden, clock: preview.clock.textContent,
        pixel: [...preview.context.getImageData(160, 90, 1, 1).data], frames: [...history.frames.values()],
        captured: history.assets.has('frame:10'), disk: Boolean(await history.disk.get(history.token, 'frame:10')),
        reads: [...reads], bytes: history.bytes, limit: history.maxBytes, decodedBytes: preview.bitmapBytes };
    };
  });

  for (const key of ['upward', 'downward']) {
    const metadata = jpegBoundsMetadata[key], precise = metadata.jpeg_frame.start;
    await page.evaluate(metadata => setupJpegBounds(metadata), metadata);
    await page.evaluate(() => jpegBounds.preview.showPoint({ value: jpegBounds.replay.session.start_seconds }));
    await page.waitForFunction(() => jpegBounds.preview.displayed?.asset === 'frame:10' && !jpegBounds.preview.resolving,
      null, { timeout: 5000 }).catch(async error => {
      console.log('P40 ' + JSON.stringify({ engine: name, scenario: key, outcome: 'first-capture-timeout',
        ...(await page.evaluate(() => readJpegBounds())), previewRequests: requests.slice(initialRequests) }));
      throw error;
    });
    const result = await page.evaluate(() => readJpegBounds());
    assert.deepEqual(result.metadata, metadata, 'The primary recorder payload must never be normalized.');
    assert.deepEqual(result.before.metadata, metadata);
    assert(result.before.cold && result.before.disk && result.captured && result.disk);
    assert.equal(result.before.frame.time, precise);
    assert.equal(result.displayed.time, precise);
    assert.equal(result.point, Math.max(metadata.start_seconds, precise));
    assert.equal(result.sheet.start, precise);
    assert.equal(result.clock, '−0:07', 'The negative label still follows the projected timeline edge.');
    assert(result.pixel[2] > 240 && result.pixel[0] < 10);
    assert(result.reads.includes('frame:10'), 'The visible capture must resolve through real IndexedDB.');
    assert(result.bytes <= result.limit && result.decodedBytes <= 8 * 1024 * 1024);
    assert.equal(requests.length, initialRequests, 'Precisely owned cold first frames must not request a server sprite.');
    await page.evaluate(() => jpegBounds.preview.showPoint({ value: jpegBounds.replay.session.jpeg_frame.start }));
    assert.deepEqual(await page.evaluate(() => ({ point: jpegBounds.preview.point.time, hidden: jpegBounds.preview.hidden })),
      { point: precise, hidden: false }, 'The exact retained start also remains a valid visible target.');
    console.log('P40 ' + JSON.stringify({ engine: name, scenario: key, outcome: 'retained-and-painted',
      ...result, previewRequests: requests.slice(initialRequests) }));
    console.log(`${name}: ${key} recorder start ${metadata.start_seconds}/${precise} keeps and paints the native captured IDB row with zero HTTP.`);
  }

  // A single accepted capture has no completed interval. A provisional legacy
  // tail must not manufacture a preview range beyond the precise descriptor.
  await page.evaluate(metadata => setupJpegBounds(metadata, false), jpegBoundsMetadata.first);
  await page.evaluate(() => jpegBounds.preview.showPoint({ value: jpegBounds.replay.session.end_seconds }));
  assert.equal(await page.evaluate(() => jpegBounds.preview.hidden), true);
  assert.equal(requests.length, initialRequests);

  await page.evaluate(metadata => setupJpegBounds(metadata), jpegBoundsMetadata.tail);
  await page.evaluate(() => jpegBounds.preview.showPoint({ value: jpegBounds.replay.session.end_seconds }));
  await page.waitForFunction(() => jpegBounds.preview.displayed?.asset === 'frame:10');
  const tail = await page.evaluate(() => readJpegBounds());
  assert.equal(tail.point, jpegBoundsMetadata.tail.jpeg_frame.position - 0.05);
  assert.equal(tail.sheet.count, 1, 'Backup sheets cannot include a provisional-tail sample.');
  assert.equal(tail.sheet.start, jpegBoundsMetadata.tail.jpeg_frame.start);
  assert.equal(requests.length, initialRequests);

  // Use actual post-prune recorder metadata, with a later first retained frame.
  // Clock invalidation hides the old target; reopening still trims the old IDB row.
  await page.evaluate(metadata => {
    jpegBounds.replay.session = structuredClone(metadata); jpegBounds.preview.updateClock();
  }, jpegBoundsMetadata.retained);
  assert.equal(await page.evaluate(() => jpegBounds.preview.hidden), true);
  await page.evaluate(() => {
    jpegBounds.preview.showPoint({ value: 0 });
    jpegBounds.preview.hide(); // Cancel an unnecessary backup after observing the real trim.
  });
  const retained = await page.evaluate(() => readJpegBounds());
  assert.equal(retained.point, jpegBoundsMetadata.retained.jpeg_frame.start);
  assert.equal(retained.captured, false); assert.equal(retained.disk, false);
  assert.equal(retained.frames.length, 0);
  assert.equal(requests.length, initialRequests);

  // Other modes retain their original legacy clipping and trimming. In the
  // remote case the receiver's bounds deliberately differ from local metadata.
  const gating = await page.evaluate(async metadata => {
    const results = [];
    for (const mode of ['legacy-jpeg', 'invalid-jpeg', 'h264', 'file', 'demo', 'remote']) {
      await setupJpegBounds(metadata, false);
      const { replay, history, preview } = jpegBounds;
      replay.session.preview_fallback = false;
      if (mode === 'legacy-jpeg') delete replay.session.jpeg_frame;
      if (mode === 'invalid-jpeg') replay.session.jpeg_frame.sequence = -1;
      if (mode === 'h264') replay.session.kind = 'h264';
      if (mode === 'file' || mode === 'demo') replay.session.kind = 'file';
      if (mode === 'demo') replay.backend.id = 'demo';
      if (mode === 'remote') replay.remote = { bounds: () => ({ start: 9, end: 20, current: 11 }) };
      history.addFrame(metadata.jpeg_frame.start, previewJpeg);
      preview.showPoint({ value: 0 });
      const result = { mode, point: preview.point?.time, sheet: preview.sheet, hidden: preview.hidden,
        captured: history.assets.has('frame:10') };
      preview.showPoint({ value: replay.session.end_seconds });
      results.push({ ...result, tailPoint: preview.point?.time, tailHidden: preview.hidden });
    }
    return results;
  }, jpegBoundsMetadata.tail);
  for (const result of gating) {
    assert.equal(result.point, jpegBoundsMetadata.tail.start_seconds, result.mode);
    assert.equal(result.sheet.start, jpegBoundsMetadata.tail.start_seconds, result.mode);
    assert.equal(result.sheet.count, 2, result.mode);
    assert.equal(result.hidden, false, result.mode); assert.equal(result.captured, false, result.mode);
    assert.equal(result.tailPoint, jpegBoundsMetadata.tail.end_seconds - 0.05, result.mode);
    assert.equal(result.tailHidden, false, result.mode);
  }
  // The remote legacy-tail point becomes invalid on returning to local precise
  // JPEG bounds, even though it still lies inside the rounded session interval.
  await page.evaluate(() => { jpegBounds.replay.remote = null; jpegBounds.preview.updateClock(); });
  assert.equal(await page.evaluate(() => jpegBounds.preview.hidden), true);
  assert.equal(requests.length, initialRequests);

  // Delayed replies exercise load's live retained-bound check, independently of
  // hiding/aborting. A valid exact-start reply paints; a trimmed reply cannot add
  // its row even though the current preview is still visible at its new target.
  await page.unroute('**/replay/*/preview.jpg?*');
  const held = [];
  await page.route('**/replay/*/preview.jpg?*', async route => {
    requests.push(route.request().url());
    await new Promise(resolve => held.push({ resolve }));
    await route.fulfill({ status: 200, contentType: 'image/jpeg', body: jpeg }).catch(() => {});
  });
  for (const outcome of ['valid', 'retained', 'session', 'provisional-end']) {
    const beforeRequests = requests.length, beforeHeld = held.length;
    const metadata = outcome === 'provisional-end' ? jpegBoundsMetadata.tail : jpegBoundsMetadata.upward;
    await page.evaluate(metadata => setupJpegBounds(metadata, false), metadata);
    if (outcome === 'provisional-end') await page.evaluate(() => {
      jpegBounds.replay.remote = { bounds: () => ({ start: 9, end: 20, current: 11 }) };
    });
    await page.evaluate(() => jpegBounds.preview.showPoint({ value: jpegBounds.replay.session.jpeg_frame.start }));
    for (let attempt = 0; held.length === beforeHeld && attempt < 100; attempt++) await page.waitForTimeout(10);
    assert.equal(held.length, beforeHeld + 1, `${outcome}: expected one held backup.`);
    const sheet = await page.evaluate(() => ({ ...jpegBounds.preview.sheet }));
    assert.equal(sheet.start, outcome === 'provisional-end' ? metadata.start_seconds : metadata.jpeg_frame.start);
    const url = new URL(requests.at(-1));
    assert.equal(Number(url.searchParams.get('at')), sheet.start);
    assert.equal(url.searchParams.get('frames'), outcome === 'provisional-end' ? '2' : '1');
    if (outcome === 'retained') {
      await page.evaluate(metadata => {
        const { replay, preview } = jpegBounds;
        replay.session = structuredClone(metadata);
        preview.showPoint({ value: metadata.jpeg_frame.start });
        // Prevent a second backup: this case isolates the still-pending old one.
        replay.session.preview_fallback = false;
        if (preview.hidden || preview.request.controller.signal.aborted) throw new Error('Retention control must keep the old reply live.');
      }, jpegBoundsMetadata.retained);
    } else if (outcome === 'session') {
      await page.evaluate(metadata => setupJpegBounds(metadata, false), jpegBoundsMetadata.downward);
      await page.evaluate(() => { jpegBounds.replay.session.preview_fallback = false; jpegBounds.preview.showPoint({ value: 11 }); });
    } else if (outcome === 'provisional-end') {
      await page.evaluate(() => {
        const { replay, preview } = jpegBounds;
        replay.remote = null; preview.showPoint({ value: replay.session.jpeg_frame.start });
        replay.session.preview_fallback = false;
        if (preview.hidden || preview.request.controller.signal.aborted) throw new Error('End control must keep the old reply live.');
      });
    }
    held[beforeHeld].resolve();
    if (outcome === 'valid') {
      await page.waitForFunction(() => jpegBounds.preview.displayed?.asset?.startsWith('sheet:') && !jpegBounds.preview.resolving);
      const valid = await page.evaluate(async () => {
        const { preview, history } = jpegBounds;
        await Promise.all([...history.writes]);
        return { hidden: preview.hidden, displayed: preview.displayed,
          pixel: [...preview.context.getImageData(160, 90, 1, 1).data],
          disk: Boolean(await history.disk.get(history.token, preview.displayed.asset)) };
      });
      assert.equal(valid.hidden, false); assert.equal(valid.displayed.time, sheet.start); assert(valid.disk);
      assert(Math.abs(valid.pixel[0] - 32) < 5 && Math.abs(valid.pixel[1] - 160) < 5);
    } else {
      await page.waitForFunction(() => !jpegBounds.preview.request && !jpegBounds.preview.resolving);
      const stale = await page.evaluate(async key => ({ hidden: jpegBounds.preview.hidden,
        frames: jpegBounds.history.frames.size, assets: jpegBounds.history.assets.size,
        disk: Boolean(await jpegBounds.history.disk.get(jpegBounds.history.token, key)),
        painted: jpegBounds.preview.painted }), 'sheet:' + sheet.start + ':' + sheet.count);
      assert.equal(stale.frames, 0); assert.equal(stale.assets, 0); assert.equal(stale.disk, false);
      assert.equal(stale.painted, false); assert.equal(stale.hidden, false);
    }
    assert.equal(requests.length, beforeRequests + 1, `${outcome}: only the intentional backup may be requested.`);
    console.log(`${name}: ${outcome} delayed precise-start fallback preserves retained/session ownership.`);
  }
  await page.evaluate(() => closeJpegBounds());
  console.log(`${name}: precise end/provisional tail, real retention pruning and all six legacy/remote mode controls passed.`);
}

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
      await checkJpegBounds(page, jpeg, requests, name);
      assert.deepEqual(await page.evaluate(() => ({ video: document.querySelector('video') === originalVideo,
        count: document.querySelectorAll('video').length, seeks: previewSeeks })), { video: true, count: 1, seeks: 0 });
      assert.deepEqual(errors, []);
      console.log(`${name}: corrupt sprite cooldown, valid retry, local fallback and cancelled response passed.`);
      console.log(`${name}: late persisted reads, target/session/visibility ownership and coalesced decoding passed.`);
      console.log(`${name}: closest cold frames replace warm neighbors in both directions; 24 contiguous retained stills paint within cache bounds, ${nearest.reads} IDB reads, no server requests or main seeks.`);
    } finally { await context.close(); await browser.close(); }
  }
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
