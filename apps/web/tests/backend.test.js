import assert from 'node:assert/strict';
import test from 'node:test';
import { backendConfig, readBackend, saveBackend } from '../src/backend/config.js';
import { PythonBackend } from '../src/backend/python.js';
import { DemoBackend } from '../src/backend/demo.js';
import { PrinterHistory } from '../src/printer-history.js';
import { PrinterTimelineEvents } from '../src/timeline-events.js';

async function openDemo(backend) {
  return (await backend.fetch('/api/sessions', { method: 'POST', body: JSON.stringify({
    camera_id: backend.catalog().default_camera_id,
  }) })).json();
}

test('a host-provided backend is retained; standalone apps require a choice and store no printer credentials', () => {
  const data = new Map();
  const storage = { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value) };
  assert.equal(readBackend(storage, 'https://app.layer.glass/', 'choose'), null);
  assert.equal(readBackend(storage, 'https://app.layer.glass/', 'demo'), null);
  assert.deepEqual(readBackend(storage, 'https://viewer.test/', 'python'), { type: 'python', url: 'https://viewer.test' });
  saveBackend({ type: 'python', url: 'https://backend.test', access_code: 'must-not-be-saved' }, storage, 'https://viewer.test/');
  assert.deepEqual(readBackend(storage, 'https://viewer.test/'), { type: 'python', url: 'https://backend.test' });
  assert(![...data.values()].join().includes('must-not-be-saved'));
  assert.deepEqual(readBackend(storage, 'https://viewer.test/?backend=demo'), { type: 'demo' });
});

test('invalid preferences recover and unsafe/mixed-content addresses are rejected before requests', () => {
  assert.equal(readBackend({ getItem: () => '{broken' }, 'https://app.layer.glass/', 'choose'), null);
  assert.deepEqual(readBackend({ getItem: () => '{broken' }, 'https://viewer.test/', 'python'), { type: 'python', url: 'https://viewer.test' });
  for (const value of [{}, { type: 'unknown' }, { type: 'python' }, { type: 'python', url: 'https://user:code@printer.test' }]) {
    assert.equal(readBackend({ getItem: () => JSON.stringify(value) }, 'https://app.layer.glass/', 'choose'), null);
  }
  for (const url of ['https://name:code@printer.test', 'https://printer.test/api', 'https://printer.test?code=secret',
    'http://192.168.1.4:8099', 'file:///tmp/video', 'javascript:alert(1)']) {
    assert.throws(() => backendConfig({ type: 'python', url }, 'https://app.layer.glass/'));
  }
  assert.equal(backendConfig({ url: 'http://192.168.1.4:8099' }, 'http://192.168.1.2/').url, 'http://192.168.1.4:8099');
  assert.deepEqual(readBackend({ getItem: () => { throw new DOMException('Storage blocked', 'SecurityError'); } }, 'https://viewer.test/', 'python'),
    { type: 'python', url: 'https://viewer.test' });
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  try {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new DOMException('Storage getter blocked', 'SecurityError'); } });
    assert.equal(readBackend(undefined, 'https://app.layer.glass/', 'choose'), null);
    assert.deepEqual(readBackend(undefined, 'https://viewer.test/', 'python'), { type: 'python', url: 'https://viewer.test' });
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else delete globalThis.localStorage;
  }
});

test('Python routes media/session URLs to its selected origin and preserves only same-origin proxy credentials', async () => {
  const requests = [];
  const backend = new PythonBackend('https://printer.test', { fetcher: async (url, options) => {
    requests.push({ url, options });
    return Response.json({ status: { playlist_url: '/stream/a/live.m3u8', jpeg_url: null },
      replay: { video_url: '/replay/a/video', frame_url: '/replay/a/frame.jpg' } });
  } });
  const data = await (await backend.fetch('/api/snapshot', { credentials: 'include' })).json();
  assert.equal(requests[0].url, 'https://printer.test/api/snapshot');
  assert.equal(requests[0].options.credentials, 'same-origin');
  assert.equal(data.status.playlist_url, 'https://printer.test/stream/a/live.m3u8');
  assert.equal(data.replay.video_url, 'https://printer.test/replay/a/video');
  assert.equal(data.replay.frame_url, 'https://printer.test/replay/a/frame.jpg');
  assert.equal(data.status.jpeg_url, null);
  assert.throws(() => backend.resolve('https://unselected.test/api/snapshot'));
  assert.throws(() => backend.resolve('https://user:code@printer.test/api/snapshot'));
});

test('Python streaming bodies are returned untouched and SSE state resolves media to the same origin', async () => {
  const body = new Response(new Uint8Array([66, 67, 86, 49]));
  const listeners = new Map();
  let address; let closed = false;
  const backend = new PythonBackend('https://printer.test', { fetcher: async () => body, eventSource: url => {
    address = url;
    return { readyState: 1, addEventListener: (kind, listener) => listeners.set(kind, listener), close: () => { closed = true; } };
  } });
  assert.equal(await backend.fetch('/replay/a/video'), body);
  const source = backend.events('/api/events?camera=fixture');
  let state;
  source.addEventListener('state', event => { state = JSON.parse(event.data); });
  listeners.get('state')({ data: JSON.stringify({ version: 1, replay: { playlist_url: '/replay/a/live.m3u8' } }) });
  assert.equal(address, 'https://printer.test/api/events?camera=fixture');
  assert.equal(state.replay.playlist_url, 'https://printer.test/replay/a/live.m3u8');
  source.close(); assert.equal(closed, true);
});

test('browser demo supports an empty page-scoped replay and clocked simulated history without any HTTP fetch', async () => {
  let now = 1000;
  const backend = new DemoBackend({ clock: () => now, prebufferSeconds: 0 });
  assert.equal(backend.capabilities.discovery, false);
  assert.equal(backend.capabilities.configuration, false);
  assert.equal(backend.capabilities.serverDvr, false);
  assert.equal(backend.capabilities.previewFallback, false);
  const catalog = await (await backend.fetch('/api/cameras')).json();
  const session = await (await backend.fetch('/api/sessions', { method: 'POST', body: JSON.stringify({ camera_id: catalog.default_camera_id }) })).json();
  assert.equal(session.kind, 'file'); assert.equal(session.demo, true);
  now += 45;
  const snapshot = backend.snapshot(`/api/events?session=${session.session_id}`);
  assert.equal(snapshot.replay.end_seconds, 45);
  assert.equal(snapshot.telemetry.samples[0].at, 1000);
  assert.equal(snapshot.telemetry.samples.at(-1).printer.elapsed_seconds, 45);
  assert.equal(snapshot.telemetry.samples.at(-1).printer.connection, 'connected');
  assert.equal(snapshot.telemetry.samples.at(-1).printer.demo, true);
  assert.equal(backend.printer(1000).print_state, 'IDLE');
  assert.equal(backend.printer(1002).print_state, 'RUNNING');
  assert.equal(backend.printer(1030).print_state, 'PAUSE');
  assert.equal(backend.printer(1035).print_state, 'RUNNING');
  assert.equal(snapshot.replay.clock[0].time, 1000);
  const history = await (await backend.fetch(`/api/sessions/${session.session_id}/printer?at=1010`)).json();
  assert.equal(history.samples.find(sample => sample.at === 1010).printer.elapsed_seconds, 10);
  assert.equal((await backend.fetch('/api/discover', { method: 'POST' })).status, 501);
  assert.equal((await backend.fetch('/api/cameras/not-a-printer/configure', { method: 'POST' })).status, 501);
  await backend.fetch(`/api/sessions/${session.session_id}/close`, { method: 'POST' });
  assert.equal(backend.session(session.session_id), null);
});

test('demo opens with three minutes of replay, recorded telemetry and deduplicated historical events', async () => {
  let now = 1234.25;
  const backend = new DemoBackend({ clock: () => now });
  const session = await openDemo(backend);
  assert.equal(session.start_seconds, 0);
  assert.equal(session.end_seconds, 180);
  assert.equal(session.clock[0].time, now - 180);
  assert.equal(backend.status().printer.print_state, 'RUNNING');
  assert.equal(backend.status().printer.progress, 60);
  const events = new PrinterTimelineEvents();
  const history = new PrinterHistory(() => {}, {
    onSession: value => events.setSession(value), onSamples: value => events.apply(value),
    fetcher: () => { throw new Error('Preloaded printer readings must be available immediately.'); },
  });
  history.setSession(session);
  const seeded = backend.snapshot(`/api/events?session=${session.session_id}`);
  assert.equal(seeded.telemetry.from, now - 180);
  assert.equal(seeded.telemetry.until, now);
  assert.equal(seeded.telemetry.samples.length, 181);
  history.apply(seeded.telemetry);
  assert.deepEqual(events.visible(session).map(({ type, position }) => [type, position]),
    [['started', 2], ['paused', 30], ['resumed', 35]]);
  assert.equal(history.read(session.clock[0].time + 31).print_state, 'PAUSE');
  assert.equal(history.read(session.clock[0].time + 36).print_state, 'RUNNING');
  history.apply(seeded.telemetry);
  assert.equal(events.visible(session).length, 3, 'Overlapping initial snapshots must not duplicate events.');
  now += 120;
  const completed = backend.snapshot(`/api/events?session=${session.session_id}`, { fromStart: false });
  history.apply(completed.telemetry);
  assert.equal(completed.replay.end_seconds, 300);
  assert.equal(events.visible(completed.replay).at(-1).type, 'finished');
  assert.equal(events.visible(completed.replay).at(-1).position, 300);
  now += 600;
  assert.equal(backend.session(session.session_id).end_seconds, 300, 'A finite demo must not invent more recorded footage.');
  assert.equal(backend.history(session.session_id, now), null, 'A future window must not fabricate recorded readings.');
});

test('demo subscriptions seed all past readings once, then use small windows and clean up on close', async context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let now = 1234.25;
  const backend = new DemoBackend({ clock: () => now });
  const session = await openDemo(backend);
  const source = backend.events(`/api/events?session=${session.session_id}`);
  const received = [];
  source.addEventListener('state', event => received.push(JSON.parse(event.data)));
  context.mock.timers.tick(1);
  assert.equal(received.length, 1);
  assert.equal(received[0].telemetry.from, now - 180);
  now++;
  context.mock.timers.tick(1000);
  assert.equal(received.length, 2);
  assert(received[1].telemetry.from > received[0].telemetry.from);
  assert(received[1].telemetry.samples.length <= 122);
  assert.equal(received[1].replay.end_seconds, 181);
  source.close();
  context.mock.timers.tick(2000);
  assert.equal(received.length, 2);
});

test('local files start a fresh empty buffer without demo telemetry or seeded events', async () => {
  let now = 1234.25;
  const backend = new DemoBackend({ clock: () => now });
  assert.equal(backend.elapsed(), 180);
  backend.setLocalMedia(new Blob(['local video']));
  try {
    backend.setDuration(300);
    const session = await openDemo(backend);
    assert.equal(session.start_seconds, 0);
    assert.equal(session.end_seconds, 0);
    assert.equal(session.clock[0].time, now);
    assert.equal(session.telemetry, false);
    assert.equal(backend.snapshot(`/api/events?session=${session.session_id}`).telemetry, null);
    now += 5;
    assert.equal(backend.session(session.session_id).end_seconds, 5);
  } finally { URL.revokeObjectURL(backend.localURL); }
});

test('demo event sources release their update timer on close', async () => {
  const backend = new DemoBackend();
  const events = backend.events('/api/events');
  let count = 0;
  await new Promise(resolve => events.addEventListener('state', () => { count++; resolve(); }));
  events.close();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(count, 1);
});
