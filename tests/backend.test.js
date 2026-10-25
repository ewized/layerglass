import assert from 'node:assert/strict';
import test from 'node:test';
import { backendConfig, readBackend, saveBackend } from '../static/backend/config.js';
import { PythonBackend } from '../static/backend/python.js';
import { DemoBackend } from '../static/backend/demo.js';

test('backend choice defaults to the self-hosted origin and stores no printer credentials', () => {
  const data = new Map();
  const storage = { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value) };
  assert.deepEqual(readBackend(storage, 'https://viewer.test/'), { type: 'python', url: 'https://viewer.test' });
  saveBackend({ type: 'python', url: 'https://backend.test', access_code: 'must-not-be-saved' }, storage, 'https://viewer.test/');
  assert.deepEqual(readBackend(storage, 'https://viewer.test/'), { type: 'python', url: 'https://backend.test' });
  assert(![...data.values()].join().includes('must-not-be-saved'));
  assert.deepEqual(readBackend(storage, 'https://viewer.test/?backend=demo'), { type: 'demo' });
});

test('invalid preferences recover and unsafe/mixed-content addresses are rejected before requests', () => {
  assert.deepEqual(readBackend({ getItem: () => '{broken' }, 'https://viewer.test/'), { type: 'python', url: 'https://viewer.test' });
  for (const url of ['https://name:code@printer.test', 'https://printer.test/api', 'https://printer.test?code=secret',
    'http://192.168.1.4:8099', 'file:///tmp/video', 'javascript:alert(1)']) {
    assert.throws(() => backendConfig({ type: 'python', url }, 'https://app.layer.glass/'));
  }
  assert.equal(backendConfig({ url: 'http://192.168.1.4:8099' }, 'http://192.168.1.2/').url, 'http://192.168.1.4:8099');
  assert.deepEqual(readBackend({ getItem: () => { throw new DOMException('Storage blocked', 'SecurityError'); } }, 'https://viewer.test/'),
    { type: 'python', url: 'https://viewer.test' });
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  try {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new DOMException('Storage getter blocked', 'SecurityError'); } });
    assert.deepEqual(readBackend(undefined, 'https://viewer.test/'), { type: 'python', url: 'https://viewer.test' });
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

test('browser demo provides page-scoped replay and clocked simulated history without any HTTP fetch', async () => {
  let now = 1000;
  const backend = new DemoBackend({ clock: () => now });
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

test('demo event sources release their update timer on close', async () => {
  const backend = new DemoBackend();
  const events = backend.events('/api/events');
  let count = 0;
  await new Promise(resolve => events.addEventListener('state', () => { count++; resolve(); }));
  events.close();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(count, 1);
});
