import assert from 'node:assert/strict';
import test from 'node:test';
import { DemoBackend } from '../src/index.js';

async function openDemo(backend) {
  return (await backend.fetch('/api/sessions', { method: 'POST', body: JSON.stringify({
    camera_id: backend.catalog().default_camera_id,
  }) })).json();
}

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

test('demo prepares one native seekable Blob when the static host returns a full 200 response', async () => {
  const requests = [];
  const backend = new DemoBackend({ media: 'https://demo.test/printer.mp4', fetcher: async (url, options) => {
    requests.push({ url, options });
    return new Response(new Blob(['bundled demo'], { type: 'video/mp4' }));
  } });
  const [first, second] = await Promise.all([backend.prepareMedia(), backend.prepareMedia()]);
  assert.equal(first, second);
  assert(first.startsWith('blob:'));
  assert.equal(await (await fetch(first)).text(), 'bundled demo');
  assert.equal(await backend.prepareMedia(), first);
  assert.equal(requests.length, 1, 'Concurrent loads and refreshes reuse one download.');
  assert.equal(requests[0].url, 'https://demo.test/printer.mp4');
  assert.equal(requests[0].options.cache, 'no-store');
  backend.setLocalMedia(new Blob(['local file']));
  try {
    await assert.rejects(fetch(first), 'Selecting a local file releases the bundled clip.');
    assert.equal(await backend.prepareMedia(), backend.localURL);
    assert.equal(requests.length, 1);
  } finally { URL.revokeObjectURL(backend.localURL); }
});

test('replacing a pending demo download aborts it and cannot replace the chosen local file', async () => {
  let finish;
  let signal;
  const backend = new DemoBackend({ fetcher: (_url, options) => {
    signal = options.signal;
    return new Promise(resolve => { finish = resolve; });
  } });
  const pending = backend.prepareMedia();
  backend.setLocalMedia(new Blob(['chosen file']));
  try {
    assert.equal(signal.aborted, true);
    finish(new Response(new Blob(['old demo'], { type: 'video/mp4' })));
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(backend.demoURL, null);
    assert.equal(await backend.prepareMedia(), backend.localURL);
  } finally { URL.revokeObjectURL(backend.localURL); }
});

test('failed or wrong-type demo responses remain retryable instead of poisoning the prepared clip', async () => {
  let count = 0;
  const backend = new DemoBackend({ fetcher: async () => {
    count++;
    if (count === 1) return new Response('unavailable', { status: 503 });
    if (count === 2) return new Response('<html>not a video</html>', { headers: { 'Content-Type': 'text/html' } });
    return new Response(new Blob(['demo video'], { type: 'video/mp4' }));
  } });
  await assert.rejects(backend.prepareMedia(), /Demo video unavailable/);
  await assert.rejects(backend.prepareMedia(), /Demo video unavailable/);
  const prepared = await backend.prepareMedia();
  assert.equal(count, 3);
  assert.equal(await (await fetch(prepared)).text(), 'demo video');
  URL.revokeObjectURL(prepared);
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
