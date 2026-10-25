import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { loadBrowserModule } from './browser-module.js';

const session = { video_url: `/replay/${'b'.repeat(32)}/video`, playlist_url: `/replay/${'b'.repeat(32)}/live.m3u8` };
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

async function harness(options = {}) {
  let now = 100;
  let id = 0;
  let failed = 0;
  const timers = new Map();
  const requests = [];
  const document = new EventTarget();
  document.hidden = false;
  const window = new EventTarget();
  const navigator = { onLine: true };
  const fetcher = options.fetcher || ((_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  }));
  const fetch = (url, init) => { requests.push({ url: String(url), init }); return fetcher(url, init); };
  Object.assign(window, { fetch, ReadableStream, AbortController });
  const context = vm.createContext({ document, window, navigator, location: { href: 'http://viewer/' }, URL,
    Uint8Array, DataView, TextDecoder, AbortController, DOMException, fetch,
    console: { info() {}, warn() {} }, performance: { now: () => now },
    setTimeout(fn, delay) { const key = ++id; timers.set(key, { at: now + delay, fn }); return key; },
    clearTimeout(key) { timers.delete(key); } });
  const { PlayerVideoStream, VideoRecords } = await loadBrowserModule('video-stream.js', context, { './vendor/hls.min.mjs': { default: { isSupported: () => true } } });
  const stream = new PlayerVideoStream(session, () => { failed++; stream.destroy(); }, options);
  const advance = async ms => {
    const end = now + ms;
    for (;;) {
      const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at;
      timers.delete(next[0]);
      next[1].fn();
      await flush();
    }
    now = end;
    await flush();
  };
  return { stream, VideoRecords, PlayerVideoStream, document, window, navigator, requests, advance, failed: () => failed };
}

test('offline closes video without retries or HLS fallback and online preserves the session', async t => {
  const h = await harness(); t.after(() => h.stream.destroy());
  h.navigator.onLine = false;
  h.window.dispatchEvent(new Event('offline'));
  assert.equal(h.requests[0].init.signal.aborted, true);
  await h.advance(180000);
  assert.equal(h.requests.length, 1);
  assert.equal(h.failed(), 0);
  h.navigator.onLine = true;
  h.window.dispatchEvent(new Event('online'));
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].url, h.requests[0].url);
});

function index(start = 0, count = 6, first = 0, type = 'index') {
  return { type, first, start, last: start + count - 1, target: 2,
    segments: Array.from({ length: count }, (_, i) => ({ sequence: start + i,
      duration: 2, discontinuity: false, discontinuities: 0, date: null })) };
}

function packet(header, bytes = new Uint8Array()) {
  const json = new TextEncoder().encode(JSON.stringify(header));
  const data = new Uint8Array(8 + json.length + bytes.length);
  const sizes = new DataView(data.buffer);
  sizes.setUint32(0, json.length);
  sizes.setUint32(4, bytes.length);
  data.set(json, 8);
  data.set(bytes, 8 + json.length);
  return data;
}

test('record parser handles arbitrarily split and coalesced network chunks', async t => {
  const h = await harness(); t.after(() => h.stream.destroy());
  const header = { type: 'segment', sequence: 7 };
  const bytes = new Uint8Array([0, 71, 255, 13, 10]);
  const all = Buffer.concat([Buffer.from('BCV1'), packet(header, bytes), packet({ type: 'heartbeat' })]);
  for (const size of [1, 3, 8, all.length]) {
    let offset = 0;
    const reader = { read: async () => offset < all.length ?
      { value: all.subarray(offset, offset += size), done: false } : { done: true } };
    const records = new h.VideoRecords(reader);
    await records.open();
    const first = await records.next();
    assert.equal(first.header.sequence, 7);
    assert.deepEqual(first.data, bytes);
    assert.equal((await records.next()).header.type, 'heartbeat');
    await assert.rejects(records.next(), /ended/);
  }
});

test('malformed framing is rejected before allocating an oversized payload', async t => {
  const h = await harness(); t.after(() => h.stream.destroy());
  const oversized = new Uint8Array(8);
  new DataView(oversized.buffer).setUint32(0, 100 * 1024 * 1024);
  const records = new h.VideoRecords({ read: async () => ({ value: oversized, done: false }) });
  await assert.rejects(records.next(), /size/);
  const invalid = new h.VideoRecords({ read: async () => ({ value: Buffer.from('NOPE'), done: false }) });
  await assert.rejects(invalid.open(), /Unsupported/);
});

test('index deltas produce the original HLS timeline without fetching a playlist', async t => {
  const h = await harness(); t.after(() => h.stream.destroy());
  h.stream.accept(index(), new Uint8Array());
  const update = index(6, 2, 0, 'update');
  update.start = 0;
  h.stream.accept(update, new Uint8Array());
  const manifest = await h.stream.playlist(new AbortController().signal);
  assert.match(manifest, /#EXT-X-PLAYLIST-TYPE:EVENT/);
  assert.equal((manifest.match(/#EXTINF:/g) || []).length, 8);
  assert.match(manifest, /segment-0.ts/);
  assert.match(manifest, /segment-7.ts/);
  assert.equal(h.requests.length, 1);
});

test('storage trimming and relay discontinuities keep correct HLS sequence numbers', async t => {
  const h = await harness(); t.after(() => h.stream.destroy());
  h.stream.accept(index(), new Uint8Array());
  h.stream.accept({ type: 'segment', sequence: 0 }, new Uint8Array(10));
  const update = index(3, 4, 0, 'update');
  update.segments[0].discontinuity = true;
  for (const item of update.segments) item.discontinuities = 2;
  h.stream.accept(update, new Uint8Array());
  const manifest = await h.stream.playlist(new AbortController().signal);
  assert.match(manifest, /#EXT-X-MEDIA-SEQUENCE:3/);
  assert.match(manifest, /#EXT-X-DISCONTINUITY-SEQUENCE:1/);
  assert.match(manifest, /#EXT-X-DISCONTINUITY\n/);
  assert.doesNotMatch(manifest, /PLAYLIST-TYPE:EVENT|segment-0.ts/);
  assert.equal(h.stream.bytes, 0);
  await assert.rejects(h.stream.segment(0, new AbortController().signal), /trimmed/);
});

test('memory cache stays bounded by bytes and count while archive descriptors remain seekable', async t => {
  const h = await harness({ maxBytes: 25, maxSegments: 2 }); t.after(() => h.stream.destroy());
  h.stream.accept(index(0, 10), new Uint8Array());
  for (let i = 0; i < 10; i++) h.stream.accept({ type: 'segment', sequence: i }, new Uint8Array(10));
  assert.equal(h.stream.cache.size, 2);
  assert.equal(h.stream.bytes, 20);
  assert.equal(h.stream.segments.size, 10);
  assert.equal(h.stream.receivedBytes, 100);
  assert.equal(h.stream.mediaBitrate, 40);
});

test('decoder buffer transfer cannot detach the retained video cache', async t => {
  const h = await harness(); t.after(() => h.stream.destroy());
  h.stream.accept(index(), new Uint8Array());
  h.stream.accept({ type: 'segment', sequence: 0 }, new Uint8Array([71, 2, 3]));
  const first = await h.stream.segment(0, new AbortController().signal);
  structuredClone(first, { transfer: [first] });
  assert.equal(first.byteLength, 0);
  assert.deepEqual(new Uint8Array(await h.stream.segment(0, new AbortController().signal)), new Uint8Array([71, 2, 3]));
  assert.equal(h.requests.length, 1);
});

test('scrubbing outside the cache repositions the stream; nearby future segments wait for push', async t => {
  const h = await harness(); t.after(() => h.stream.destroy());
  h.stream.accept(index(0, 50), new Uint8Array());
  h.stream.nextSequence = 30;
  const starts = [];
  h.stream.connect = start => { starts.push(start); h.stream.nextSequence = start; };
  const old = h.stream.segment(2, new AbortController().signal);
  assert.deepEqual(starts, [2]);
  h.stream.accept({ type: 'segment', sequence: 2 }, new Uint8Array([71]));
  assert.equal((await old).byteLength, 1);
  const future = h.stream.segment(3, new AbortController().signal);
  assert.deepEqual(starts, [2]);
  h.stream.accept({ type: 'segment', sequence: 3 }, new Uint8Array([72]));
  assert.equal((await future).byteLength, 1);
});

test('cancelled loads release their waiters and cannot deliver stale data', async t => {
  const h = await harness(); t.after(() => h.stream.destroy());
  const controller = new AbortController();
  const pending = h.stream.playlist(controller.signal);
  assert.equal(h.stream.listeners.size, 1);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(h.stream.listeners.size, 0);
});

test('a forward seek does not wait for the old paced replay to reach its target', async t => {
  const h = await harness(); t.after(() => h.stream.destroy());
  h.stream.accept(index(0, 50), new Uint8Array());
  const starts = [];
  h.stream.connect = start => { starts.push(start); h.stream.nextSequence = start; };
  for (const target of [11, 12]) {
    h.stream.nextSequence = 10;
    const pending = h.stream.segment(target, new AbortController().signal);
    assert.equal(starts.at(-1), target, 'Skipping even one recorded fragment must reposition immediately.');
    h.stream.accept({ type: 'segment', sequence: target }, new Uint8Array([71]));
    await pending;
  }
  assert.deepEqual(starts, [11, 12]);
});

test('backgrounding closes the video response and returning reconnects the same page', async t => {
  const h = await harness(); t.after(() => h.stream.destroy());
  h.document.hidden = true;
  h.document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(h.requests[0].init.signal.aborted, true);
  await h.advance(90000);
  assert.equal(h.requests.length, 1);
  h.document.hidden = false;
  h.document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].url, h.requests[0].url);
});

test('broken streaming endpoints retry with backoff and fall back after three failures', async t => {
  const h = await harness({ fetcher: async () => { throw new Error('Offline'); } }); t.after(() => h.stream.destroy());
  await flush();
  assert.equal(h.requests.length, 1);
  await h.advance(999);
  assert.equal(h.requests.length, 1);
  await h.advance(1);
  assert.equal(h.requests.length, 2);
  await h.advance(2000);
  assert.equal(h.requests.length, 3);
  assert.equal(h.failed(), 1);
  await h.advance(120000);
  assert.equal(h.requests.length, 3);
});

test('successful media between short disconnects resets consecutive transport failures', async t => {
  const h = await harness({ fetcher: async () => ({ ok: true, body: new ReadableStream({ start(controller) {
    controller.enqueue(Buffer.concat([Buffer.from('BCV1'), packet(index()),
      packet({ type: 'segment', sequence: 0 }, new Uint8Array([71, 1, 2]))]));
    controller.close();
  } }) }) });
  t.after(() => h.stream.destroy());
  await flush();
  for (let attempt = 0; attempt < 5; attempt++) await h.advance(1000);
  assert(h.requests.length >= 5);
  assert.equal(h.failed(), 0, 'Playable media must prevent unrelated short outages from permanently enabling HLS.');
  assert.equal(h.stream.failures, 1);
});

test('a background probe can fail once without starting an internal retry loop', async t => {
  const h = await harness({ failureLimit: 1, quiet: true, fetcher: async () => { throw new Error('Unavailable'); } });
  t.after(() => h.stream.destroy());
  await flush();
  await h.advance(180000);
  assert.equal(h.requests.length, 1);
  assert.equal(h.failed(), 1);
});

test('pagehide cannot reopen a response through late visibility events; pageshow restores it', async t => {
  const h = await harness(); t.after(() => h.stream.destroy());
  h.window.dispatchEvent(new Event('pagehide'));
  h.document.dispatchEvent(new Event('visibilitychange'));
  h.window.dispatchEvent(new Event('online'));
  await h.advance(90000);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].init.signal.aborted, true);
  h.window.dispatchEvent(new Event('pageshow'));
  assert.equal(h.requests.length, 2);
});

test('a response that buffers its first bytes falls back before the playback stall deadline', async t => {
  const h = await harness(); t.after(() => h.stream.destroy());
  await h.advance(15000);
  assert.equal(h.requests.length, 3);
  assert.equal(h.failed(), 1);
});

test('custom loader answers asynchronously, reports cache statistics, and obeys abort', async t => {
  const h = await harness(); t.after(() => h.stream.destroy());
  class Base {
    constructor() { this.stats = { loading: {}, parsing: {}, buffering: {} }; }
    load() { throw new Error('Unexpected HTTP request'); }
    abort() {}
    destroy() {}
  }
  const Loader = h.stream.loader({ DefaultConfig: { loader: Base } });
  h.stream.accept(index(), new Uint8Array());
  const loader = new Loader();
  let result;
  const context = { url: `http://viewer${session.playlist_url}`, responseType: 'text', type: 'manifest' };
  loader.load(context, { timeout: 10000 }, { onSuccess: (...args) => { result = args; } });
  assert.equal(result, undefined);
  const originalStats = loader.stats;
  await flush();
  assert.equal(result[1], originalStats);
  assert.equal(originalStats.loaded, result[0].data.length);
  assert.equal(originalStats.loading.end, originalStats.loading.first);
  assert.equal(originalStats.loading.end, originalStats.loading.start);
  loader.destroy();
  const cancelled = new Loader();
  let aborted = 0;
  cancelled.load(context, { timeout: 10000 }, { onSuccess: () => assert.fail('Stale callback'), onAbort: () => { aborted++; } });
  cancelled.abort();
  await flush();
  assert.equal(aborted, 1);
  assert.equal(cancelled.stats.aborted, true);
  cancelled.destroy();
});
