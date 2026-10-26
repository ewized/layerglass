import assert from 'node:assert/strict';
import test from 'node:test';
import { DirectPrinterBackend, directOrigin, probeDirectPrinter, directBrowserError } from '../src/backend/direct.js';
import { DirectMjpegStream, MultipartJpegDecoder } from '../src/direct-stream.js';
import { PageReplay } from '../src/replay.js';
import { backendConfig, readBackend, saveBackend } from '../src/backend/config.js';

const origin = 'https://printer.test';
const camera = { uid: 'camera-one', name: 'Print chamber', enabled: true, service: 'mjpegstreamer', stream_url: '/webcam/?action=stream' };
const server = { moonraker_version: 'v0.9.3', api_version: [1, 5, 0], components: ['klippy_apis', 'webcams'], klippy_connected: true };
const printer = { state: 'ready', hostname: 'workshop-klipper', software_version: 'v0.13.0' };
const fixtures = (overrides = {}) => ({ '/server/info': server, '/printer/info': printer,
  '/server/webcams/list': { webcams: [camera] }, ...overrides });

test('direct configuration is separate from demo and persists only the approved profile and origin', () => {
  let saved;
  const storage = { setItem: (_, value) => { saved = value; }, getItem: () => saved };
  const value = { type: 'direct', profile: 'moonraker', url: origin, api_key: 'not-persisted' };
  assert.deepEqual(saveBackend(value, storage, 'https://app.layer.glass'), { type: 'direct', profile: 'moonraker', url: origin });
  assert(!saved.includes('not-persisted'));
  assert.deepEqual(readBackend(storage, 'https://app.layer.glass', 'choose'), { type: 'direct', profile: 'moonraker', url: origin });
  assert.deepEqual(backendConfig({ type: 'demo' }), { type: 'demo' });
  assert.throws(() => backendConfig({ ...value, profile: 'unapproved' }), /not approved/);
  saved = JSON.stringify({ ...value, profile: 'unapproved' });
  assert.equal(readBackend(storage, 'https://app.layer.glass', 'choose'), null);
});
function fixtureFetcher(data = fixtures(), requests = []) {
  return async (url, options) => {
    requests.push({ url, options });
    return Response.json({ result: data[new URL(url).pathname] });
  };
}

test('direct provider probes once per page and has no recording, printer-history, scan or command transport', async () => {
  const requests = [];
  const backend = new DirectPrinterBackend(origin, { fetcher: fixtureFetcher(fixtures(), requests) });
  const [catalog, snapshot] = await Promise.all([
    backend.fetch('/api/cameras').then(response => response.json()),
    backend.fetch('/api/snapshot').then(response => response.json()),
  ]);
  assert.equal(requests.length, 3);
  assert.equal(catalog.cameras.length, 1);
  assert.equal(snapshot.status.mjpeg_url, origin + '/webcam/?action=stream');
  assert.equal(snapshot.session_id, null); assert.equal(snapshot.replay, null);
  assert.equal(backend.capabilities.liveOnly, true); assert.equal(backend.capabilities.telemetry, false);
  assert.equal(backend.capabilities.serverDvr, false); assert.equal(backend.capabilities.cameraSelection, true);
  for (const [path, method] of [['/api/sessions', 'POST'], ['/api/discover', 'POST'], ['/api/sessions/abc/printer?at=12', 'GET'],
    ['/printer/print/start', 'POST'], ['/api/cameras/abc/configure', 'POST']]) {
    assert.equal((await backend.fetch(path, { method })).status, 501);
  }
  assert.equal(requests.length, 3, 'Unsupported operations never touch the printer.');
  assert.equal(await PageReplay.prototype.open.call({ backend, fetcher: () => assert.fail('No DVR API') }, catalog.cameras[0].id), null);
  const events = backend.events('/api/events');
  await new Promise(resolve => events.addEventListener('state', event => { assert.equal(JSON.parse(event.data).status.live_only, true); resolve(); }));
  events.close();
  assert.equal(requests.length, 3, 'In-memory state and heartbeats never poll printer APIs.');
  await backend.refresh();
  assert.equal(requests.length, 6, 'An explicit refresh can recheck the intended controller.');
});
