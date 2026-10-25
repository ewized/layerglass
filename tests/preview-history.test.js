import assert from 'node:assert/strict';
import test from 'node:test';
import { PreviewHistory, PreviewCapture } from '../static/preview-history.js';

const session = session_id => ({ session_id });
const blob = (value, size = 20000) => new Blob([new Uint8Array(size).fill(value)], { type: 'image/jpeg' });
const settle = history => Promise.all([...history.writes]);
function diskStore() {
  const rows = new Map(), removed = [];
  return { available: true, rows, removed,
    put: async row => { rows.set(row.session + row.key, row); return true; },
    get: async (token, key) => rows.get(token + key),
    remove: async (token, key) => rows.delete(token + key),
    removeSession: async token => { removed.push(token); for (const [key, row] of rows) if (row.session === token) rows.delete(key); },
  };
}

test('45 minutes of five-second JPEGs stay available locally within the RAM limit', async () => {
  const h = new PreviewHistory({ disk: null });
  h.setSession(session('page'));
  for (let time = 0; time < 2700; time += 5) h.addFrame(time + 0.1, blob(time % 256));
  assert.equal(h.frames.size, 540);
  assert.equal(h.bytes, 10800000);
  assert(h.bytes < h.maxBytes);
  for (let time = 2699; time >= 0; time -= 3) {
    const found = await h.get(time);
    assert(found);
    assert(Math.abs(found.frame.time - time) <= 5);
    assert.equal(found.asset.blob.size, 20000);
  }
  h.setSession(null);
  assert.equal(h.frames.size + h.assets.size + h.hot.size + h.bytes, 0);
});

test('RAM eviction retains disk-backed history and coalesces disk reads', async () => {
  const disk = diskStore(), h = new PreviewHistory({ disk, maxBytes: 40000 });
  h.setSession(session('page'));
  for (let time = 0; time < 2700; time += 5) { h.addFrame(time, blob(time % 256)); await settle(h); }
  assert.equal(h.frames.size, 540);
  assert(h.bytes <= 40000);
  assert.equal(h.peek(0), null);
  let reads = 0;
  const get = disk.get;
  disk.get = async (...args) => { reads++; return get(...args); };
  const found = await Promise.all([h.get(0), h.get(1)]);
  assert.equal(reads, 1);
  assert(found.every(entry => entry.frame.time === 0 && entry.asset.blob.size === 20000));
  assert.equal(new Uint8Array(await found[0].asset.blob.arrayBuffer())[0], 0);
  assert(h.bytes <= h.maxBytes);
  assert.equal(h.peek(2699, Infinity)?.frame.time, 2695, 'A distant resident image can be an immediate labelled placeholder.');
});

test('denied/quota-limited storage stays bounded and removes unreadable metadata', async () => {
  const h = new PreviewHistory({ disk: { ...diskStore(), put: async () => false }, maxBytes: 40000 });
  h.setSession(session('page'));
  for (let time = 0; time < 1000; time += 5) { h.addFrame(time, blob(1)); await settle(h); }
  assert(h.bytes <= h.maxBytes);
  assert.equal(h.frames.size, 2);
  assert.equal(await h.get(0), null);
  assert(await h.get(995));
});

test('slow writes cannot grow an unbounded pending queue or leave orphan frames', async () => {
  const release = [];
  const h = new PreviewHistory({ disk: { ...diskStore(), put: () => new Promise(resolve => release.push(resolve)) }, maxBytes: 1 });
  h.setSession(session('page'));
  for (let time = 0; time < 100; time += 5) h.addFrame(time, blob(1));
  assert.equal(h.writes.size, 8);
  assert.equal(h.frames.size, 8);
  assert.equal(h.bytes, 0);
  for (const resolve of release) resolve(false);
  await settle(h);
  assert.equal(h.frames.size + h.assets.size, 0);
});

test('server sprites share one blob; captured frames take priority over late server replies', () => {
  const h = new PreviewHistory({ disk: null });
  h.setSession(session('page'));
  h.addSheet({ start: 0, count: 2 }, blob(1, 100));
  assert.equal(h.frames.size, 2);
  h.addSheet({ start: 0, count: 6 }, blob(2, 600));
  assert.equal(h.frames.size, 6);
  assert.equal(h.bytes, 600);
  h.addFrame(10.2, blob(3, 200));
  h.addSheet({ start: 0, count: 3 }, blob(4, 300));
  assert.equal(h.peek(10).frame.time, 10.2);
  assert.equal(h.peek(10).frame.capture, true);
  h.trim(13.6);
  assert.equal(h.frames.size, 3);
  assert([...h.frames.values()].every(frame => frame.time >= 13.6));
});

test('old page reads/writes cannot populate a new session, even with the same frame times', async () => {
  const disk = diskStore(), h = new PreviewHistory({ disk, maxBytes: 1 });
  h.setSession(session('old-page'));
  h.addFrame(0, blob(1)); await settle(h);
  let release;
  disk.get = () => new Promise(resolve => { release = resolve; });
  const pending = h.get(0);
  h.setSession(session('new-page'));
  release({ blob: blob(1) });
  assert.equal(await pending, null);
  assert.equal(h.frames.size + h.bytes, 0);
  assert.deepEqual(disk.removed, ['old-page']);
  h.addFrame(0, blob(2)); await settle(h);
  h.setSession(null);
  assert.deepEqual(disk.removed, ['old-page', 'new-page']);
});

test('missing disk assets drop stale metadata and bounded frame history trims the oldest records', async () => {
  const disk = diskStore(), h = new PreviewHistory({ disk, maxBytes: 1, maxFrames: 3 });
  h.setSession(session('page'));
  for (let time = 0; time < 30; time += 5) { h.addFrame(time, blob(1)); await settle(h); }
  assert.deepEqual(h.keys, [15, 20, 25]);
  disk.rows.clear();
  assert.equal(await h.get(15, 0), null);
  assert.deepEqual(h.keys, [20, 25]);
});

function captureFixture() {
  const doc = new EventTarget(), view = new EventTarget(), callbacks = [], encodes = [], draws = [];
  const canvas = { getContext: () => ({ fillRect() {}, drawImage: (...args) => draws.push(args) }),
    toBlob: callback => encodes.push(callback) };
  Object.assign(doc, { hidden: false, defaultView: view, createElement: () => canvas });
  const previous = globalThis.document;
  globalThis.document = doc;
  const video = Object.assign(new EventTarget(), { ownerDocument: doc, readyState: 4,
    currentTime: 1, videoWidth: 1920, videoHeight: 1080, paused: false, seeking: false,
    requestVideoFrameCallback: callback => { callbacks.push(callback); return callbacks.length; }, cancelVideoFrameCallback() {} });
  const image = Object.assign(new EventTarget(), { hidden: true });
  const replay = { session: { session_id: 'page', ready: true, start_seconds: 0 } };
  const history = new PreviewHistory({ disk: null }); history.setSession(replay.session);
  const capture = new PreviewCapture(history, video, image, () => replay);
  return { doc, video, replay, history, capture, callbacks, encodes, draws,
    close() { capture.close(); if (previous === undefined) delete globalThis.document; else globalThis.document = previous; } };
}

test('capture reads the existing decoder once per five-second bucket and uses the presented frame timestamp', () => {
  const f = captureFixture();
  try {
    f.capture.sample(); assert.equal(f.callbacks.length, 1);
    f.callbacks[0](0, { mediaTime: 1.12 }); f.encodes[0](blob(1));
    assert.equal(f.history.peek(1).frame.time, 1.12);
    for (let i = 0; i < 100; i++) { f.capture.lastAttempt = -Infinity; f.video.currentTime = 2; f.capture.sample(); }
    assert.equal(f.callbacks.length, 1);
    f.video.currentTime = 5.1; f.capture.sample();
    f.callbacks[1](0, { mediaTime: 5.13 }); f.encodes[1](blob(2));
    assert.equal(f.history.frames.size, 2);
    assert.equal(f.draws.length, 2);
    assert.deepEqual(f.draws[0].slice(1), [0, 0, 320, 180]);
  } finally { f.close(); }
});

test('cancelled capture callbacks cannot add old frames or unlock a newer capture', () => {
  const f = captureFixture();
  try {
    f.capture.sample(); f.callbacks[0](0, { mediaTime: 1.12 });
    f.capture.reset();
    f.replay.session = { session_id: 'new-page', ready: true, start_seconds: 10 };
    f.history.setSession(f.replay.session);
    f.video.currentTime = 11; f.capture.sample();
    f.encodes[0](blob(1));
    assert.equal(f.capture.pending, true);
    assert.equal(f.history.frames.size, 0);
    f.callbacks[1](0, { mediaTime: 11.1 }); f.encodes[1](blob(2));
    assert.equal(f.history.frames.size, 1);
    assert.equal(f.history.peek(11).frame.time, 11.1);
  } finally { f.close(); }
});

test('capture skips unrecorded, hidden and remote footage and handles forbidden canvas access', () => {
  const f = captureFixture();
  try {
    f.replay.session.start_seconds = 10; f.capture.sample();
    f.video.currentTime = 12; f.doc.hidden = true; f.capture.sample();
    f.doc.hidden = false; f.replay.remote = true; f.capture.sample();
    assert.equal(f.callbacks.length, 0);
    f.replay.remote = false; f.video.paused = true;
    f.doc.createElement = () => ({ getContext: () => ({ fillRect() {}, drawImage() { throw new DOMException('Origin', 'SecurityError'); } }) });
    f.capture.sample();
    assert.equal(f.capture.unavailable, true);
    assert.equal(f.capture.pending, false);
    assert.equal(f.history.frames.size, 0);
  } finally { f.close(); }
});
