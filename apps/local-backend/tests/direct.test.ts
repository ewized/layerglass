import { testDouble } from '../../../tests/doubles.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { DirectPrinterBackend, directOrigin, probeDirectPrinter, directBrowserError } from '../src/direct.js';
import { DirectMjpegStream, MultipartJpegDecoder } from '../src/stream.js';

const origin = 'https://printer.test';
const camera = {
  uid: 'camera-one',
  name: 'Print chamber',
  enabled: true,
  service: 'mjpegstreamer',
  stream_url: '/webcam/?action=stream',
};
const server = {
  moonraker_version: 'v0.9.3',
  api_version: [1, 5, 0],
  components: ['klippy_apis', 'webcams'],
  klippy_connected: true,
};
const printer = { state: 'ready', hostname: 'workshop-klipper', software_version: 'v0.13.0' };
type FetchRequest = { url: string; options: RequestInit | undefined };
const fixtures = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  '/server/info': server,
  '/printer/info': printer,
  '/server/webcams/list': { webcams: [camera] },
  ...overrides,
});

function fixtureFetcher(data = fixtures(), requests: FetchRequest[] = []): typeof fetch {
  return async (input, options) => {
    const url = input instanceof Request ? input.url : String(input);
    requests.push({ url, options });
    return Response.json({ result: data[new URL(url).pathname] });
  };
}

test('WebKit and iOS browser variants reject unsupported direct MJPEG before any stream can leak', () => {
  for (const agent of [
    'AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15',
    'AppleWebKit/605.1.15 CriOS/145.0 Mobile Safari/604.1',
    'AppleWebKit/605.1.15 FxiOS/145.0 Mobile Safari/604.1',
  ]) {
    assert.match(directBrowserError(agent)!, /Safari and iPhone.*Docker/);
  }
  assert.equal(directBrowserError('AppleWebKit/537.36 Chrome/145.0 Safari/537.36'), null);
  assert.equal(directBrowserError('AppleWebKit/537.36 Chrome/145.0 Mobile Safari/537.36'), null);
});

test('direct admission requires a connected Moonraker and Klipper identity before webcams can be offered', async () => {
  const requests: FetchRequest[] = [];
  const identity = await probeDirectPrinter(origin, { fetcher: fixtureFetcher(fixtures(), requests) });
  assert.equal(identity.cameras.length, 1);
  assert.equal(identity.cameras[0]!.name, 'Print chamber');
  assert.equal(identity.cameras[0]!.model_name, 'Klipper');
  assert.match(identity.cameras[0]!.id, /^[a-f0-9]{16}$/);
  assert.equal(identity.cameras[0]!.stream_url, origin + '/webcam/?action=stream');
  assert.deepEqual(requests.map((item) => new URL(item.url).pathname).sort(), [
    '/printer/info',
    '/server/info',
    '/server/webcams/list',
  ]);
  for (const { options } of requests) {
    assert.equal(options!.method, 'GET');
    assert.equal(options!.credentials, 'omit');
    assert.equal(options!.redirect, 'error');
    assert.equal(options!.cache, 'no-store');
  }
  for (const info of [
    {},
    { ...server, moonraker_version: '' },
    { ...server, components: [] },
    { ...server, klippy_connected: false },
  ]) {
    const rejected: FetchRequest[] = [];
    await assert.rejects(
      probeDirectPrinter(origin, { fetcher: fixtureFetcher(fixtures({ '/server/info': info }), rejected) }),
    );
    assert.deepEqual(
      rejected.map((item) => new URL(item.url).pathname),
      ['/server/info'],
    );
  }
  await assert.rejects(
    probeDirectPrinter(origin, {
      fetcher: fixtureFetcher(fixtures({ '/printer/info': { state: 'ready' } })),
    }),
    /connected Klipper/,
  );
  const unsupported = {
    profile: 'moonraker' as const,
    fetcher: () => assert.fail('No unsupported network request'),
  };
  Object.defineProperty(unsupported, 'profile', { value: 'bambu' });
  await assert.rejects(probeDirectPrinter(origin, unsupported), /not approved/);
});

test('direct cameras must be enabled approved MJPEG entries on the selected origin without URL secrets', async () => {
  const invalid = [
    { ...camera, uid: 'off-origin', stream_url: 'https://camera.other/stream' },
    { ...camera, uid: 'credentials', stream_url: 'https://name:code@printer.test/stream' },
    { ...camera, uid: 'key-query', stream_url: '/stream?api_key=secret' },
    { ...camera, uid: 'blob', stream_url: 'blob:https://printer.test/camera' },
    { ...camera, uid: 'off', enabled: false },
    { ...camera, uid: 'webrtc', service: 'webrtc-camerastreamer' },
    { ...camera, uid: '', service: 'mjpegstreamer' },
    { ...camera, uid: 'rtsp', stream_url: 'rtsps://printer.test:322/stream' },
    { ...camera, uid: 'hash', stream_url: '/stream#secret' },
  ];
  const identity = await probeDirectPrinter(origin, {
    fetcher: fixtureFetcher(fixtures({ '/server/webcams/list': { webcams: [...invalid, camera, camera] } })),
  });
  assert.deepEqual(
    identity.cameras.map((item) => item.name),
    ['Print chamber'],
  );
  await assert.rejects(
    probeDirectPrinter(origin, {
      fetcher: fixtureFetcher(fixtures({ '/server/webcams/list': { webcams: invalid } })),
    }),
    /No enabled, same-origin MJPEG/,
  );
});

test('direct origins fail unsafe schemes, camera paths, credentials and mixed content before any probing', async () => {
  for (const url of [
    'https://user:secret@printer.test',
    'rtsps://printer.test:322',
    'https://printer.test/webcam',
    'https://printer.test?api_key=secret',
    'http://192.168.1.5',
    'https://printer.test#camera',
    'not-a-url',
  ]) {
    await assert.rejects(
      probeDirectPrinter(url, {
        page: 'https://app.layer.glass',
        fetcher: () => assert.fail('No network for invalid origins'),
      }),
    );
  }
  assert.equal(directOrigin('http://192.168.1.5', 'http://viewer.test/'), 'http://192.168.1.5');
  await assert.rejects(
    probeDirectPrinter(origin, { fetcher: async () => new Response('', { status: 401 }) }),
    /authorized local access/,
  );
  await assert.rejects(
    probeDirectPrinter(origin, {
      fetcher: async () => {
        throw new TypeError('CORS');
      },
    }),
    /HTTPS, CORS and trusted local access/,
  );
});

test('a rejected direct profile remains unsupported rather than silently becoming demo or polling the network', async () => {
  let count = 0;
  const backend = new DirectPrinterBackend(origin, {
    fetcher: async () => {
      count++;
      return Response.json({ unrelated: true });
    },
  });
  for (let index = 0; index < 3; index++) {
    const snapshot = await (await backend.fetch('/api/snapshot')).json();
    assert.equal(snapshot.status.state, 'unsupported');
    assert.equal(snapshot.catalog.cameras.length, 0);
    assert.equal(snapshot.replay, null);
  }
  assert.equal(count, 1);
});

test('a late Direct probe success cannot replace a completed refresh or its current error', async () => {
  for (const currentFails of [false, true]) {
    let release!: (response: Response) => void;
    let serverRequests = 0;
    let stale = false;
    const first = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const backend = new DirectPrinterBackend(origin, {
      fetcher: async (url) => {
        const path = new URL(url instanceof Request ? url.url : url).pathname;
        if (path === '/server/info' && ++serverRequests === 1) return first;
        const data = fixtures({
          '/server/webcams/list': {
            webcams: [
              {
                ...camera,
                name: stale ? 'Old configuration' : 'Refreshed configuration',
                stream_url: stale ? '/old-stream' : '/new-stream',
              },
            ],
          },
        });
        return Response.json({ result: path === '/server/info' && currentFails ? {} : data[path] });
      },
    });
    const old = backend.ready();
    assert.equal(backend.ready(), old, 'Concurrent reads share the current probe.');
    const current = backend.refresh();
    const currentProbe = backend.ready();
    if (currentFails) await assert.rejects(current);
    else await current;
    const identity = backend['identity'],
      error = backend['error'];
    stale = true;
    release!(Response.json({ result: server }));
    await old;
    assert.equal(
      backend['identity'],
      identity,
      'The old response cannot replace the latest identity or failure.',
    );
    assert.equal(backend['error'], error);
    if (!currentFails) assert.equal(backend.status(null).mjpeg_url, origin + '/new-stream');
    assert.equal(
      backend.ready(),
      currentProbe,
      'Completing the older caller does not restore its cached promise.',
    );
  }
});

test('a late Direct probe failure cannot mark the refreshed controller unavailable', async () => {
  let reject;
  let calls = 0;
  const first = new Promise<Response>((_resolve, fail) => {
    reject = fail;
  });
  const fetcher = fixtureFetcher();
  const backend = new DirectPrinterBackend(origin, {
    fetcher: (...args) => (++calls === 1 ? first : fetcher(...args)),
  });
  const old = backend.ready();
  const current = backend.refresh();
  const currentProbe = backend.ready();
  await current;
  const identity = backend['identity'];
  reject!(new TypeError('An old probe lost its connection.'));
  await assert.rejects(old);
  assert.equal(backend['identity'], identity);
  assert.equal(backend['error'], null);
  assert.equal(backend.ready(), currentProbe);
  assert.equal(calls, 4, 'The stale failure does not start another identity probe.');
});

const jpeg = new Uint8Array([255, 216, 1, 2, 3, 255, 217]);
function multipart({ length = true, data = jpeg } = {}) {
  const prefix = new TextEncoder().encode(
    `--camera\r\nContent-Type: image/jpeg\r\n${length ? `Content-Length: ${data.length}\r\n` : ''}\r\n`,
  );
  const end = new TextEncoder().encode('\r\n--camera--\r\n');
  const bytes = new Uint8Array(prefix.length + data.length + end.length);
  bytes.set(prefix);
  bytes.set(data, prefix.length);
  bytes.set(end, prefix.length + data.length);
  return bytes;
}

test('MJPEG framing handles every byte boundary with and without Content-Length and retains no completed frames', () => {
  for (const length of [true, false]) {
    const frames: Array<Uint8Array<ArrayBuffer>> = [];
    const decoder = new MultipartJpegDecoder('multipart/x-mixed-replace; boundary="camera"', (bytes) =>
      frames.push(bytes),
    );
    for (const byte of multipart({ length })) decoder.push(new Uint8Array([byte]));
    assert.deepEqual(frames, [jpeg]);
    assert.equal(decoder['done'], true);
    assert.equal(decoder['buffer'].length, 0);
  }
});

test('MJPEG rejects other media, invalid JPEGs and oversized or unbounded framing', () => {
  assert.throws(() => new MultipartJpegDecoder('video/mp4', () => {}), /MJPEG/);
  assert.throws(
    () => new MultipartJpegDecoder('multipart/x-mixed-replace; boundary=' + 'x'.repeat(129), () => {}),
    /MJPEG/,
  );
  const make = () => new MultipartJpegDecoder('multipart/x-mixed-replace; boundary=camera', () => {});
  assert.throws(() => make().push(multipart({ data: new Uint8Array([0, 0, 0, 0]) })), /invalid JPEG/);
  assert.throws(
    () =>
      make().push(
        new TextEncoder().encode('--camera\r\nContent-Type: image/jpeg\r\nContent-Length: 9000000\r\n\r\n'),
      ),
    /frame limit/,
  );
  assert.throws(
    () => make().push(new TextEncoder().encode('--camera\r\n' + 'x'.repeat(9000))),
    /oversized MJPEG headers/,
  );
  assert.throws(
    () => make().push(new TextEncoder().encode('--camera\r\nContent-Type: text/html\r\n\r\n')),
    /non-JPEG/,
  );
});

class ImageFixture extends EventTarget {
  declare src: string;

  constructor() {
    super();
    this.src = '';
  }
  removeAttribute(name: string) {
    if (name === 'src') this.src = '';
  }
  decodeFrame() {
    this.dispatchEvent(new Event('load'));
  }
}

test('one direct stream bounds pending images and releases its reader and object URLs on switch', async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array<ArrayBuffer>>;
  let requests = 0;
  let aborted = false;
  let decoded = 0;
  const image = new ImageFixture();
  const stream = new DirectMjpegStream(
    testDouble<ConstructorParameters<typeof DirectMjpegStream>[0]>(image),
    origin + '/webcam/',
    {
      onFrame: () => decoded++,
      fetcher: async (url, options) => {
        requests++;
        assert.equal(url, origin + '/webcam/');
        assert.equal(options!.redirect, 'error');
        assert.equal(options!.credentials, 'omit');
        options!.signal!.addEventListener(
          'abort',
          () => {
            aborted = true;
            controller.close();
          },
          { once: true },
        );
        return new Response(
          new ReadableStream<Uint8Array<ArrayBuffer>>({
            start(value) {
              controller = value;
            },
          }),
          {
            headers: { 'Content-Type': 'multipart/x-mixed-replace; boundary=camera' },
          },
        );
      },
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  const part = multipart().slice(0, -new TextEncoder().encode('\r\n--camera--\r\n').length); // Keep the response open.
  controller!.enqueue(part);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert(image.src.startsWith('blob:'));
  assert.equal(stream['urls'].size, 1);
  image.decodeFrame();
  assert.equal(decoded, 1);
  for (let index = 0; index < 20; index++) stream.present(jpeg);
  assert.equal(stream['urls'].size, 2);
  assert(stream['queued']);
  image.decodeFrame();
  image.decodeFrame();
  assert.equal(stream['urls'].size, 1);
  assert.equal(stream['queued'], null);
  stream.destroy();
  await stream.finished;
  assert.equal(aborted, true);
  assert.equal(image.src, '');
  assert.equal(stream['urls'].size, 0);
  assert.equal(requests, 1);
  image.src = 'new-camera';
  image.decodeFrame();
  assert.equal(decoded, 3, 'Old stream listeners are removed before another camera attaches.');
});

test('failed MJPEG responses report once and never fabricate playback or retry per frame', async () => {
  const image = new ImageFixture();
  let failures = 0;
  let requests = 0;
  const stream = new DirectMjpegStream(
    testDouble<ConstructorParameters<typeof DirectMjpegStream>[0]>(image),
    origin + '/webcam/',
    {
      onFailure: () => failures++,
      fetcher: async () => {
        requests++;
        return new Response('not a webcam', { headers: { 'Content-Type': 'text/html' } });
      },
    },
  );
  await stream.finished;
  stream.fail(new Error('again'));
  assert.equal(failures, 1);
  assert.equal(requests, 1);
  assert.equal(image.src, '');
  stream.destroy();
});
