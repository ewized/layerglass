import assert from 'node:assert/strict';
import test from 'node:test';
import { DirectPrinterBackend, directOrigin, probeDirectPrinter } from '../src/backend/direct.js';
import { DirectMjpegStream, MultipartJpegDecoder } from '../src/direct-stream.js';
import { PageReplay } from '../src/replay.js';

const origin = 'https://printer.test';
const camera = { uid: 'camera-one', name: 'Print chamber', enabled: true, service: 'mjpegstreamer', stream_url: '/webcam/?action=stream' };
const server = { moonraker_version: 'v0.9.3', api_version: [1, 5, 0], components: ['klippy_apis', 'webcams'], klippy_connected: true };
const printer = { state: 'ready', hostname: 'workshop-klipper', software_version: 'v0.13.0' };
const fixtures = (overrides = {}) => ({ '/server/info': server, '/printer/info': printer,
  '/server/webcams/list': { webcams: [camera] }, ...overrides });
function fixtureFetcher(data = fixtures(), requests = []) {
  return async (url, options) => {
    requests.push({ url, options });
    return Response.json({ result: data[new URL(url).pathname] });
  };
}

test('direct admission requires a connected Moonraker and Klipper identity before webcams can be offered', async () => {
  const requests = [];
  const identity = await probeDirectPrinter(origin, { fetcher: fixtureFetcher(fixtures(), requests) });
  assert.equal(identity.cameras.length, 1);
  assert.equal(identity.cameras[0].name, 'Print chamber');
  assert.equal(identity.cameras[0].model_name, 'Klipper');
  assert.match(identity.cameras[0].id, /^[a-f0-9]{16}$/);
  assert.equal(identity.cameras[0].stream_url, origin + '/webcam/?action=stream');
  assert.deepEqual(requests.map(item => new URL(item.url).pathname).sort(), ['/printer/info', '/server/info', '/server/webcams/list']);
  for (const { options } of requests) {
    assert.equal(options.method, 'GET'); assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error'); assert.equal(options.cache, 'no-store');
  }
  for (const info of [{}, { ...server, moonraker_version: '' }, { ...server, components: [] }, { ...server, klippy_connected: false }]) {
    const rejected = [];
    await assert.rejects(probeDirectPrinter(origin, { fetcher: fixtureFetcher(fixtures({ '/server/info': info }), rejected) }));
    assert.deepEqual(rejected.map(item => new URL(item.url).pathname), ['/server/info']);
  }
  await assert.rejects(probeDirectPrinter(origin, { fetcher: fixtureFetcher(fixtures({ '/printer/info': { state: 'ready' } })) }), /connected Klipper/);
  await assert.rejects(probeDirectPrinter(origin, { profile: 'bambu', fetcher: () => assert.fail('No unsupported network request') }), /not approved/);
});

test('direct cameras must be enabled approved MJPEG entries on the selected origin without URL secrets', async () => {
  const invalid = [
    { ...camera, uid: 'off-origin', stream_url: 'https://camera.other/stream' },
    { ...camera, uid: 'credentials', stream_url: 'https://name:code@printer.test/stream' },
    { ...camera, uid: 'key-query', stream_url: '/stream?api_key=secret' },
    { ...camera, uid: 'off', enabled: false }, { ...camera, uid: 'webrtc', service: 'webrtc-camerastreamer' },
    { ...camera, uid: '', service: 'mjpegstreamer' }, { ...camera, uid: 'rtsp', stream_url: 'rtsps://printer.test:322/stream' },
    { ...camera, uid: 'hash', stream_url: '/stream#secret' },
  ];
  const identity = await probeDirectPrinter(origin, { fetcher: fixtureFetcher(fixtures({ '/server/webcams/list': { webcams: [...invalid, camera, camera] } })) });
  assert.deepEqual(identity.cameras.map(item => item.name), ['Print chamber']);
  await assert.rejects(probeDirectPrinter(origin, { fetcher: fixtureFetcher(fixtures({ '/server/webcams/list': { webcams: invalid } })) }), /No enabled, same-origin MJPEG/);
});

test('direct origins fail unsafe schemes, camera paths, credentials and mixed content before any probing', async () => {
  for (const url of ['https://user:secret@printer.test', 'rtsps://printer.test:322', 'https://printer.test/webcam',
    'https://printer.test?api_key=secret', 'http://192.168.1.5', 'https://printer.test#camera', 'not-a-url']) {
    await assert.rejects(probeDirectPrinter(url, { page: 'https://app.layer.glass', fetcher: () => assert.fail('No network for invalid origins') }));
  }
  assert.equal(directOrigin('http://192.168.1.5', 'http://viewer.test/'), 'http://192.168.1.5');
  await assert.rejects(probeDirectPrinter(origin, { fetcher: async () => new Response('', { status: 401 }) }), /authorized local access/);
  await assert.rejects(probeDirectPrinter(origin, { fetcher: async () => { throw new TypeError('CORS'); } }), /HTTPS, CORS and trusted local access/);
});

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

test('a rejected direct profile remains unsupported rather than silently becoming demo or polling the network', async () => {
  let count = 0;
  const backend = new DirectPrinterBackend(origin, { fetcher: async () => { count++; return Response.json({ unrelated: true }); } });
  for (let index = 0; index < 3; index++) {
    const snapshot = await (await backend.fetch('/api/snapshot')).json();
    assert.equal(snapshot.status.state, 'unsupported'); assert.equal(snapshot.catalog.cameras.length, 0);
    assert.equal(snapshot.replay, null);
  }
  assert.equal(count, 1);
});

const jpeg = new Uint8Array([255, 216, 1, 2, 3, 255, 217]);
function multipart({ length = true, data = jpeg } = {}) {
  const prefix = new TextEncoder().encode(`--camera\r\nContent-Type: image/jpeg\r\n${length ? `Content-Length: ${data.length}\r\n` : ''}\r\n`);
  const end = new TextEncoder().encode('\r\n--camera--\r\n');
  const bytes = new Uint8Array(prefix.length + data.length + end.length);
  bytes.set(prefix); bytes.set(data, prefix.length); bytes.set(end, prefix.length + data.length);
  return bytes;
}

test('MJPEG framing handles every byte boundary with and without Content-Length and retains no completed frames', () => {
  for (const length of [true, false]) {
    const frames = [];
    const decoder = new MultipartJpegDecoder('multipart/x-mixed-replace; boundary="camera"', bytes => frames.push(bytes));
    for (const byte of multipart({ length })) decoder.push(new Uint8Array([byte]));
    assert.deepEqual(frames, [jpeg]); assert.equal(decoder.done, true); assert.equal(decoder.buffer.length, 0);
  }
});

test('MJPEG rejects other media, invalid JPEGs and oversized or unbounded framing', () => {
  assert.throws(() => new MultipartJpegDecoder('video/mp4', () => {}), /MJPEG/);
  assert.throws(() => new MultipartJpegDecoder('multipart/x-mixed-replace; boundary=' + 'x'.repeat(129), () => {}), /MJPEG/);
  const make = () => new MultipartJpegDecoder('multipart/x-mixed-replace; boundary=camera', () => {});
  assert.throws(() => make().push(multipart({ data: new Uint8Array([0, 0, 0, 0]) })), /invalid JPEG/);
  assert.throws(() => make().push(new TextEncoder().encode('--camera\r\nContent-Type: image/jpeg\r\nContent-Length: 9000000\r\n\r\n')), /frame limit/);
  assert.throws(() => make().push(new TextEncoder().encode('--camera\r\n' + 'x'.repeat(9000))), /oversized MJPEG headers/);
  assert.throws(() => make().push(new TextEncoder().encode('--camera\r\nContent-Type: text/html\r\n\r\n')), /non-JPEG/);
});

class ImageFixture extends EventTarget {
  constructor() { super(); this.src = ''; }
  removeAttribute(name) { if (name === 'src') this.src = ''; }
  decodeFrame() { this.dispatchEvent(new Event('load')); }
}

test('one direct stream bounds pending images and releases its reader and object URLs on switch', async () => {
  let controller; let requests = 0; let aborted = false; let decoded = 0;
  const image = new ImageFixture();
  const stream = new DirectMjpegStream(image, origin + '/webcam/', { onFrame: () => decoded++,
    fetcher: async (url, options) => {
      requests++; assert.equal(url, origin + '/webcam/'); assert.equal(options.redirect, 'error');
      assert.equal(options.credentials, 'omit');
      options.signal.addEventListener('abort', () => { aborted = true; controller.close(); }, { once: true });
      return new Response(new ReadableStream({ start(value) { controller = value; } }), {
        headers: { 'Content-Type': 'multipart/x-mixed-replace; boundary=camera' },
      });
    } });
  await new Promise(resolve => setTimeout(resolve, 0));
  const part = multipart().slice(0, -new TextEncoder().encode('\r\n--camera--\r\n').length); // Keep the response open.
  controller.enqueue(part);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert(image.src.startsWith('blob:')); assert.equal(stream.urls.size, 1);
  image.decodeFrame(); assert.equal(decoded, 1);
  for (let index = 0; index < 20; index++) stream.present(jpeg);
  assert.equal(stream.urls.size, 2); assert(stream.queued);
  image.decodeFrame(); image.decodeFrame();
  assert.equal(stream.urls.size, 1); assert.equal(stream.queued, null);
  stream.destroy(); await stream.finished;
  assert.equal(aborted, true); assert.equal(image.src, ''); assert.equal(stream.urls.size, 0); assert.equal(requests, 1);
  image.src = 'new-camera'; image.decodeFrame();
  assert.equal(decoded, 3, 'Old stream listeners are removed before another camera attaches.');
});

test('failed MJPEG responses report once and never fabricate playback or retry per frame', async () => {
  const image = new ImageFixture(); let failures = 0; let requests = 0;
  const stream = new DirectMjpegStream(image, origin + '/webcam/', { onFailure: () => failures++,
    fetcher: async () => { requests++; return new Response('not a webcam', { headers: { 'Content-Type': 'text/html' } }); } });
  await stream.finished;
  stream.fail(new Error('again'));
  assert.equal(failures, 1); assert.equal(requests, 1); assert.equal(image.src, '');
  stream.destroy();
});
