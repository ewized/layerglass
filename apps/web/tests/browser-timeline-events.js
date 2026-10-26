import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { waitForPlayer } from './player-page.js';

const base = process.env.VIEWER_URL || 'http://127.0.0.1:8080';
const selected = process.env.BROWSER;
for (const [name, engine] of Object.entries({ chromium, webkit })) {
  if (selected && selected !== name) continue;
  const browser = await engine.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const errors = [];
  const historyRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (/\/api\/sessions\/[^/]+\/printer/.test(request.url())) historyRequests.push(request.url());
  });
  try {
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await waitForPlayer(page, ({ app }) => app.pageReplay.session?.ready && app.video.videoWidth > 0 &&
      !app.video.paused && app.pageReplay.bounds().end > 12, null, { timeout: 60000 });
    await page.evaluate(async () => {
      const app = await import('/static/player.js');
      const { timelineTime } = await import('/static/timeline-events.js');
      const replay = app.pageReplay;
      replay.togglePause();
      const samples = [[0.25, 'IDLE'], [0.5, 'PREPARE'], [0.75, 'PAUSE'], [1, 'RUNNING'], [8, 'FINISH']]
        .map(([position, print_state]) => ({ at: timelineTime(replay.session, position), printer: { connection: 'connected', print_state, error: 0 } }));
      app.printerHistory.apply({ session_id: replay.session.session_id, camera_id: replay.session.camera_id,
        from: samples[0].at, until: samples.at(-1).at, samples }, false);
      replay.timeline.fit(); replay.render(); app.playerChrome.show();
      window.markerVideo = app.video;
      window.markerSession = replay.session.session_id;
      window.markerSeeks = [];
      const seek = replay.seek.bind(replay);
      replay.seek = target => { window.markerSeeks.push(target); seek(target); };
    });
    const markers = page.locator('#timeline-events');
    await page.waitForFunction(() => document.querySelectorAll('.timeline-event').length === 2);
    const mainRequests = historyRequests.length;
    await markers.locator('.timeline-event').first().hover();
    assert.equal(await markers.locator('.timeline-event-tooltip > span').textContent(), '3 print events');
    assert.match(await markers.locator('.timeline-event-tooltip time').textContent(), /^−\d+:\d{2}$/);
    assert.equal(await page.evaluate(() => window.markerSeeks.length), 0, 'Hovering must not seek.');
    assert.equal(historyRequests.length, mainRequests, 'Event labels must not fetch printer history.');
    const bounds = await page.evaluate(() => {
      const marker = document.querySelector('.timeline-event').getBoundingClientRect();
      const slider = document.querySelector('#replay-slider').getBoundingClientRect();
      return { overlap: marker.bottom > slider.top, width: marker.width, sliderWidth: slider.width };
    });
    assert.equal(bounds.overlap, false, 'Marker touch targets must not cover the native scrub input.');
    assert.equal(bounds.width, 32);
    assert(bounds.sliderWidth > 300);

    // Native buttons provide touch activation; clustered events expose exact
    // observations without hiding them behind a single arbitrary seek target.
    await markers.locator('.timeline-event').first().tap();
    assert.equal(await markers.locator('[role="menu"]').isVisible(), true);
    assert.equal(await page.evaluate(async () => {
      const chrome = (await import('/static/player.js')).playerChrome;
      const playing = chrome.isPlaying; chrome.isPlaying = () => true;
      try { return chrome.canHide(); } finally { chrome.isPlaying = playing; }
    }), false, 'An open touch event picker keeps the player controls visible.');
    assert.deepEqual(await markers.locator('[role="menuitem"] span').allTextContents(), ['Print started', 'Print paused', 'Print resumed']);
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(() => document.activeElement.querySelector('span')?.textContent), 'Print paused');
    await page.keyboard.press('Enter');
    assert.deepEqual(await page.evaluate(() => window.markerSeeks), [0.75]);
    assert.equal(await markers.locator('[role="menu"]').count(), 0);
    assert.deepEqual(errors, []);
    assert.equal(await page.evaluate(() => document.activeElement.classList.contains('timeline-event')), true);
    await page.keyboard.press('ArrowRight');
    assert.match(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), /^Print finished, −/);
    await page.keyboard.press('Enter');
    assert.deepEqual(await page.evaluate(() => window.markerSeeks), [0.75, 8]);
    assert.equal(await page.evaluate(() => document.querySelector('video') === window.markerVideo), true);
    assert.equal(await page.evaluate(async () => (await import('/static/player.js')).pageReplay.session.session_id === window.markerSession), true);

    await markers.locator('.timeline-event').first().tap();
    await page.keyboard.press('Escape');
    assert.equal(await markers.locator('[role="menu"]').count(), 0);
    assert.equal(await page.evaluate(() => document.activeElement.classList.contains('timeline-event')), true);
    await page.evaluate(() => {
      const events = document.querySelector('#timeline-events');
      const parent = events.parentElement;
      const next = events.nextSibling;
      events.remove(); parent.insertBefore(events, next);
    });
    await markers.locator('.timeline-event').first().tap();
    await markers.locator('[role="menuitem"]').first().tap();
    assert.deepEqual(await page.evaluate(() => window.markerSeeks), [0.75, 8, 0.5],
      'Reconnecting must not duplicate event activation listeners.');

    // Gesture previews keep the existing mapping and commit only on release.
    const slider = page.locator('#replay-slider');
    const track = await slider.boundingBox();
    await page.mouse.move(track.x + track.width * 0.6, track.y + track.height / 2);
    await page.mouse.down();
    await page.mouse.move(track.x + track.width * 0.4, track.y + track.height / 2, { steps: 8 });
    assert.equal(await page.evaluate(() => window.markerSeeks.length), 3);
    await page.mouse.up();
    assert.equal(await page.evaluate(() => window.markerSeeks.length), 4);
    await page.evaluate(async () => {
      const app = await import('/static/player.js');
      app.printerHistory.setSession({ ...app.pageReplay.session, session_id: 'another-page' });
      app.pageReplay.render();
    });
    assert.equal(await markers.locator('.timeline-event').count(), 0, 'A replacement session removes all old markers.');
    assert.deepEqual(errors, []);
    console.log(`${name}: recorded timeline markers, negative-offset labels, touch clusters, keyboard navigation, one seek per activation, unchanged scrub gestures/video/session and no extra history requests passed`);
    await page.goto('about:blank');
  } finally { await browser.close(); }
}
// Recorder-derived envelopes: generate-tail.py and the unchanged P42 fractional
// recorder controls. JPEG bytes reuse the generated native-decoding color fixture.
const eventJpegData = {
  "tail": {
    "initial": {
      "session": {
        "session_id": "5f6dabb25de640ff9133b33101b3fcb6",
        "camera_id": "1234567890abcdef",
        "kind": "jpeg",
        "playlist_url": null,
        "video_url": null,
        "frame_url": "/replay/5f6dabb25de640ff9133b33101b3fcb6/frame.jpg",
        "start_seconds": 0,
        "end_seconds": 3,
        "clock": [
          {
            "position": 0,
            "time": 1000
          }
        ],
        "end_time": 1002,
        "ready": true,
        "limited": false,
        "error": null,
        "jpeg_frame": {
          "sequence": 2,
          "start": 0,
          "position": 2,
          "time": 1002,
          "clock": [
            {
              "position": 0,
              "time": 1000
            }
          ]
        }
      },
      "history": {
        "session_id": "5f6dabb25de640ff9133b33101b3fcb6",
        "camera_id": "1234567890abcdef",
        "from": 960,
        "until": 1002.5,
        "cursor": 3,
        "samples": [
          {
            "at": 1000,
            "printer": {
              "connection": "connected",
              "print_state": "RUNNING",
              "error": 0,
              "layer": 2
            }
          },
          {
            "at": 1001,
            "printer": {
              "connection": "connected",
              "print_state": "RUNNING",
              "error": 0,
              "layer": 2
            }
          },
          {
            "at": 1002,
            "printer": {
              "connection": "connected",
              "print_state": "RUNNING",
              "error": 0,
              "layer": 2
            }
          },
          {
            "at": 1002.5,
            "printer": {
              "connection": "connected",
              "print_state": "PAUSE",
              "error": 0,
              "layer": 3
            }
          }
        ]
      },
      "frames": [
        {
          "position": 0,
          "sequence": 0,
          "color": "red"
        },
        {
          "position": 1,
          "sequence": 1,
          "color": "green"
        },
        {
          "position": 2,
          "sequence": 2,
          "color": "blue"
        }
      ]
    },
    "completed": {
      "session": {
        "session_id": "5f6dabb25de640ff9133b33101b3fcb6",
        "camera_id": "1234567890abcdef",
        "kind": "jpeg",
        "playlist_url": null,
        "video_url": null,
        "frame_url": "/replay/5f6dabb25de640ff9133b33101b3fcb6/frame.jpg",
        "start_seconds": 0,
        "end_seconds": 31,
        "clock": [
          {
            "position": 0,
            "time": 1000
          }
        ],
        "end_time": 1030,
        "ready": true,
        "limited": false,
        "error": null,
        "jpeg_frame": {
          "sequence": 3,
          "start": 0,
          "position": 30,
          "time": 1030,
          "clock": [
            {
              "position": 0,
              "time": 1000
            }
          ]
        }
      },
      "history": {
        "session_id": "5f6dabb25de640ff9133b33101b3fcb6",
        "camera_id": "1234567890abcdef",
        "from": 960,
        "until": 1030,
        "cursor": 4,
        "samples": [
          {
            "at": 1000,
            "printer": {
              "connection": "connected",
              "print_state": "RUNNING",
              "error": 0,
              "layer": 2
            }
          },
          {
            "at": 1001,
            "printer": {
              "connection": "connected",
              "print_state": "RUNNING",
              "error": 0,
              "layer": 2
            }
          },
          {
            "at": 1002,
            "printer": {
              "connection": "connected",
              "print_state": "RUNNING",
              "error": 0,
              "layer": 2
            }
          },
          {
            "at": 1002.5,
            "printer": {
              "connection": "connected",
              "print_state": "PAUSE",
              "error": 0,
              "layer": 3
            }
          },
          {
            "at": 1030,
            "printer": {
              "connection": "connected",
              "print_state": "PAUSE",
              "error": 0,
              "layer": 3
            }
          }
        ]
      },
      "frames": [
        {
          "position": 0,
          "sequence": 0,
          "color": "red"
        },
        {
          "position": 1,
          "sequence": 1,
          "color": "green"
        },
        {
          "position": 2,
          "sequence": 2,
          "color": "blue"
        },
        {
          "position": 30,
          "sequence": 3,
          "color": "green"
        }
      ]
    },
    "retained": {
      "session": {
        "session_id": "5f6dabb25de640ff9133b33101b3fcb6",
        "camera_id": "1234567890abcdef",
        "kind": "jpeg",
        "playlist_url": null,
        "video_url": null,
        "frame_url": "/replay/5f6dabb25de640ff9133b33101b3fcb6/frame.jpg",
        "start_seconds": 30,
        "end_seconds": 41,
        "clock": [
          {
            "position": 0,
            "time": 1000
          }
        ],
        "end_time": 1040,
        "ready": true,
        "limited": true,
        "error": null,
        "jpeg_frame": {
          "sequence": 4,
          "start": 30,
          "position": 40,
          "time": 1040,
          "clock": [
            {
              "position": 0,
              "time": 1000
            }
          ]
        }
      },
      "history": {
        "session_id": "5f6dabb25de640ff9133b33101b3fcb6",
        "camera_id": "1234567890abcdef",
        "from": 960,
        "until": 1040,
        "cursor": 5,
        "samples": [
          {
            "at": 1030,
            "printer": {
              "connection": "connected",
              "print_state": "PAUSE",
              "error": 0,
              "layer": 3
            }
          },
          {
            "at": 1040,
            "printer": {
              "connection": "connected",
              "print_state": "PAUSE",
              "error": 0,
              "layer": 3
            }
          }
        ]
      },
      "frames": [
        {
          "position": 30,
          "sequence": 3,
          "color": "green"
        },
        {
          "position": 40,
          "sequence": 4,
          "color": "red"
        }
      ]
    }
  },
  "fractional-origin-mapping": {
    "session": {
      "session_id": "cfd2aedbd1954d92b52c4ed9d3b9642f",
      "camera_id": "1234567890abcdef",
      "kind": "jpeg",
      "playlist_url": null,
      "video_url": null,
      "frame_url": "/replay/cfd2aedbd1954d92b52c4ed9d3b9642f/frame.jpg",
      "start_seconds": 10.123,
      "end_seconds": 12.499,
      "clock": [
        {
          "position": -20.001,
          "time": 1000
        }
      ],
      "end_time": 1031.5,
      "ready": true,
      "limited": false,
      "error": null,
      "jpeg_frame": {
        "sequence": 2,
        "start": 10.12320000000011,
        "position": 11.499400000000037,
        "time": 1031.5,
        "clock": [
          {
            "position": -20.000599999999963,
            "time": 1000
          }
        ]
      }
    },
    "history": {
      "session_id": "cfd2aedbd1954d92b52c4ed9d3b9642f",
      "camera_id": "1234567890abcdef",
      "from": 960,
      "until": 1031.5,
      "cursor": 4,
      "samples": [
        {
          "at": 1020.001,
          "printer": {
            "connection": "connected",
            "print_state": "RUNNING",
            "error": 0,
            "layer": 2
          }
        },
        {
          "at": 1021,
          "printer": {
            "connection": "connected",
            "print_state": "RUNNING",
            "error": 0,
            "layer": 2
          }
        },
        {
          "at": 1030.124,
          "printer": {
            "connection": "connected",
            "print_state": "PAUSE",
            "error": 0,
            "layer": 3
          }
        },
        {
          "at": 1031.5,
          "printer": {
            "connection": "connected",
            "print_state": "PAUSE",
            "error": 0,
            "layer": 3
          }
        }
      ]
    },
    "target": 10.12340000000006,
    "frames": [
      {
        "position": 10.12320000000011,
        "sequence": 1,
        "color": "blue"
      },
      {
        "position": 11.499400000000037,
        "sequence": 2,
        "color": "green"
      }
    ]
  },
  "fractional-anchor-retention": {
    "session": {
      "session_id": "be73daec7793483e8ca2ed88bbb612d8",
      "camera_id": "1234567890abcdef",
      "kind": "jpeg",
      "playlist_url": null,
      "video_url": null,
      "frame_url": "/replay/be73daec7793483e8ca2ed88bbb612d8/frame.jpg",
      "start_seconds": 10.123,
      "end_seconds": 12.499,
      "clock": [
        {
          "position": -20.001,
          "time": 1000.0006
        }
      ],
      "end_time": 1031.5,
      "ready": true,
      "limited": false,
      "error": null,
      "jpeg_frame": {
        "sequence": 2,
        "start": 10.122600000000034,
        "position": 11.49879999999996,
        "time": 1031.5,
        "clock": [
          {
            "position": -20.000600000000077,
            "time": 1000.0006
          }
        ]
      }
    },
    "history": {
      "session_id": "be73daec7793483e8ca2ed88bbb612d8",
      "camera_id": "1234567890abcdef",
      "from": 960,
      "until": 1031.5,
      "cursor": 4,
      "samples": [
        {
          "at": 1021,
          "printer": {
            "connection": "connected",
            "print_state": "RUNNING",
            "error": 0,
            "layer": 2
          }
        },
        {
          "at": 1030.124,
          "printer": {
            "connection": "connected",
            "print_state": "PAUSE",
            "error": 0,
            "layer": 3
          }
        },
        {
          "at": 1031.5,
          "printer": {
            "connection": "connected",
            "print_state": "PAUSE",
            "error": 0,
            "layer": 3
          }
        }
      ]
    },
    "target": 10.122799999999984,
    "frames": [
      {
        "position": 10.122600000000034,
        "sequence": 1,
        "color": "blue"
      },
      {
        "position": 11.49879999999996,
        "sequence": 2,
        "color": "green"
      }
    ]
  }
};
const eventJpegColors = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('./fixtures/jpeg-clock.json', import.meta.url), 'utf8')).colors;

function jpegEventReady({ app, owner }) {
  const replay = app.pageReplay, session = replay.session, frame = replay.decodedImage();
  const image = document.querySelector('#jpeg');
  if (!session || !frame || replay.attaching || replay.imageLoading || !image.complete ||
      image.naturalWidth <= 0 || image.naturalHeight <= 0) return false;
  const source = new URL(frame.source, location.href), expected = new URL(session.frame_url, location.href);
  return frame.session === owner.session && frame.camera === owner.camera &&
    frame.session === session.session_id && frame.camera === session.camera_id && frame.version === replay.version &&
    image === replay.image && image.src === frame.url && source.origin === expected.origin && source.pathname === expected.pathname;
}

function jpegEventState({ app }) {
  const replay = app.pageReplay, image = document.querySelector('#jpeg'), video = app.video;
  const pending = replay.imageRequest;
  return { paused: replay.paused, followLive: replay.followLive, attaching: replay.attaching,
    mediaRestore: replay.mediaRestore, position: replay.position, version: replay.version,
    owner: { session: replay.session?.session_id, camera: replay.session?.camera_id },
    frame: replay.decodedImage(), storedFrame: replay.imageFrame, imageLoading: replay.imageLoading,
    pending: pending && { session: pending.session, camera: pending.camera, version: pending.version,
      position: pending.position, source: pending.source, aborted: pending.controller.signal.aborted },
    image: { src: image.src, complete: image.complete, width: image.naturalWidth, height: image.naturalHeight },
    video: { paused: video.paused, currentTime: video.currentTime, readyState: video.readyState,
      seeking: video.seeking, src: video.src, hidden: video.hidden }, videos: document.querySelectorAll('video').length,
    nativeOnline: window.fixtureNativeOnline, online: navigator.onLine };
}

async function jpegEventViewer(browser, initial, { beforePause, holdImage = false, owner = {
  session: initial.session.session_id, camera: initial.session.camera_id,
} } = {}) {
  const { createServer } = await import('node:http');
  const { readFile } = await import('node:fs/promises');
  const source = new URL('../src/', import.meta.url), streams = new Set(), requests = [], opens = [];
  let current = initial;
  const camera = current.session.camera_id;
  const catalog = { default_camera_id: camera, cameras: [{ id: camera, name: 'Generated event camera',
    model_name: 'Generated event camera', model: 'A1', configured: true, discovered: true,
    serial: 'GENERATED-EVENTS', host: 'fixture.invalid', port: 6000 }],
  discovery: { state: 'done', networks: [], checked: 0, total: 0 } };
  const state = token => ({ version: 1, catalog, status: { camera_id: camera, state: 'live', generation: 'a'.repeat(32),
    jpeg_url: `/api/cameras/${camera}/frame.jpg`, printer: current.history.samples.at(-1).printer },
  ...(token ? { session_id: token, replay: current.session, telemetry: current.history } : {}) });
  const json = (response, value) => response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://fixture.invalid');
    if (url.pathname === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html' }).end(`<!doctype html><html><head>
        <meta name="layerglass-backend" content="python"><meta name="viewport" content="width=device-width,initial-scale=1">
        <link rel="stylesheet" href="/static/style.css"></head><body><printer-player id="player" class="player" tabindex="0"></printer-player>
        <script type="module" src="/static/player.js"></script></body></html>`); return;
    }
    if (url.pathname === '/api/events') {
      const token = url.searchParams.get('session');
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
      const stream = { response, token }; streams.add(stream);
      response.on('close', () => streams.delete(stream));
      response.write('event: state\ndata: ' + JSON.stringify(state(token)) + '\n\n'); return;
    }
    if (url.pathname === '/api/sessions' && request.method === 'POST') {
      opens.push(current.session.session_id); json(response, current.session); return;
    }
    if (url.pathname === '/api/cameras') { json(response, catalog); return; }
    if (url.pathname === '/api/status') { json(response, state().status); return; }
    if (url.pathname === '/api/snapshot') { json(response, state(url.searchParams.get('session'))); return; }
    if (url.pathname.endsWith('/close')) { json(response, {}); return; }
    if (url.pathname.endsWith('/printer')) { requests.push({ kind: 'history' }); json(response, current.history); return; }
    if (url.pathname.endsWith('/frame.jpg')) {
      const frame = url.searchParams.has('frame') ? Number(url.searchParams.get('frame')) : null;
      const at = url.searchParams.has('at') ? Number(url.searchParams.get('at')) : null;
      const covered = current.frames.filter(item => frame === null || item.sequence <= frame);
      if (!covered.length || frame !== null && covered.at(-1).sequence !== frame ||
          at !== null && (at < covered[0].position || at > covered.at(-1).position)) { response.writeHead(404).end(); return; }
      const chosen = at === null ? covered.at(-1) : covered.findLast(item => item.position <= at);
      requests.push({ kind: 'image', at, frame, color: chosen.color });
      if (holdImage) {
        response.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' });
        response.flushHeaders(); return; // Real pending response body; no image/native state mock.
      }
      response.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' }).end(Buffer.from(eventJpegColors[chosen.color], 'base64')); return;
    }
    if (url.pathname.startsWith('/static/')) {
      const file = new URL(url.pathname.slice(8), source);
      if (!file.href.startsWith(source.href)) { response.writeHead(404).end(); return; }
      try { response.writeHead(200, { 'Content-Type': file.pathname.endsWith('.css') ? 'text/css' : 'text/javascript' }).end(await readFile(file)); }
      catch { response.writeHead(404).end(); }
      return;
    }
    response.writeHead(404).end();
  });
  let context, page, app, preparation, stage = 'listen';
  const errors = [], external = [], snapshots = [];
  const closed = { handle: false, context: false, server: false };
  const cleanup = async () => {
    const failures = [];
    for (const [resource, close] of [
      ['handle', () => app?.dispose()], ['context', () => context?.close()],
      ['server', async () => {
        server.closeAllConnections();
        if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      }],
    ]) {
      try { await close(); closed[resource] = true; }
      catch (error) { failures.push({ resource, name: error.name, message: error.message }); }
    }
    return failures;
  };
  const capture = async label => {
    if (snapshots.length < 6) snapshots.push({ label, state: app ? await page.evaluate(jpegEventState, { app }) : null });
  };
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    stage = 'context';
    context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
    await context.addInitScript(() => {
      window.fixtureNativeOnline = navigator.onLine;
      Object.defineProperty(navigator, 'onLine', { get: () => true });
    });
    page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      if (new URL(route.request().url()).origin === origin) return route.continue();
      external.push(route.request().url()); return route.abort();
    });
    stage = 'navigate';
    await page.goto(origin);
    app = await page.evaluateHandle(() => import('/static/player.js'));
    const wait = predicate => page.waitForFunction(predicate, { app }, { timeout: 10000 });
    stage = 'initial-owned-native';
    await capture('initial');
    await page.waitForFunction(jpegEventReady, { app, owner }, { timeout: 10000 });
    await capture('ready');
    if (beforePause) await beforePause({ page, app, requests, opens });
    stage = 'prepare-paused';
    assert.equal(await page.evaluate(jpegEventReady, { app, owner }), true, 'Pause setup still owns a complete native image');
    await capture('before-pause');
    preparation = await page.evaluate(({ app }) => {
      const replay = app.pageReplay, session = replay.session, frame = replay.decodedImage(), src = replay.image.src;
      const before = replay.paused;
      if (!before) app.pageReplay.togglePause();
      const after = app.pageReplay.paused;
      app.playerTools.stats.show(true); app.playerChrome.show();
      window.eventVideo = app.video; window.eventNativeSeeks = 0;
      app.video.addEventListener('seeking', () => window.eventNativeSeeks++);
      window.eventCalls = []; window.eventEmits = [];
      const seek = app.pageReplay.seek.bind(app.pageReplay);
      app.pageReplay.seek = position => { window.eventCalls.push(position); seek(position); };
      document.querySelector('#timeline-events').addEventListener('timeline-event-seek', event => window.eventEmits.push(event.detail));
      return { before, after, toggles: before ? 0 : 1, sameSession: session === replay.session,
        sameFrame: frame === replay.decodedImage(), sameSource: src === replay.image.src };
    }, { app });
    await capture('after-pause');
    assert.equal(preparation.after, true, 'The single requested Pause action must settle immediately');
    assert.equal(preparation.sameSession && preparation.sameFrame && preparation.sameSource, true, 'Pause keeps its owned native frame');
    stage = 'paused-native';
    await wait(({ app }) => app.pageReplay.paused && app.pageReplay.decodedImage() &&
      document.querySelector('#jpeg').complete && document.querySelector('#jpeg').naturalWidth > 0);
    await capture('paused-ready');
    console.log(JSON.stringify({ fixture: 'jpeg-event-setup', owner, preparation, snapshots }));
    const read = () => page.evaluate(async ({ app }) => {
      const { printerPlaybackTime } = await import('/static/printer-history.js');
      const image = document.querySelector('#jpeg'), canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 36;
      canvas.getContext('2d').drawImage(image, 0, 0);
      const time = printerPlaybackTime(app.video, app.hls, app.pageReplay);
      app.playerTools.stats.renderStats();
      const markers = document.querySelector('#timeline-events');
      return { position: app.pageReplay.position, time, state: app.printerHistory.peek(time)?.print_state,
        statsState: app.playerTools.stats.querySelector('[data-stat-key="print_state"]')?.textContent,
        pixel: [...canvas.getContext('2d').getImageData(32, 18, 1, 1).data],
        naturalSize: [image.naturalWidth, image.naturalHeight], imageLoading: app.pageReplay.imageLoading,
        frame: app.pageReplay.decodedImage(), session: app.pageReplay.session.session_id,
        groups: markers.groups.map(group => ({ fraction: group.fraction, events: group.events })), summaries: markers.history.events,
        calls: window.eventCalls, emits: window.eventEmits, sameVideo: app.video === window.eventVideo,
        videos: document.querySelectorAll('video').length, nativeSeeks: window.eventNativeSeeks,
        nativeOnline: window.fixtureNativeOnline, online: navigator.onLine };
    }, { app });
    return { page, app, wait, read, requests, opens, preparation, snapshots,
      publish(value) { current = value; for (const stream of streams) stream.response.write('event: state\ndata: ' + JSON.stringify(state(stream.token)) + '\n\n'); },
      async close() {
        const failures = await cleanup();
        assert.deepEqual(failures, [], 'JPEG fixture cleanup');
        assert.deepEqual(errors, []); assert.deepEqual(external, []);
      } };
  } catch (error) {
    try { await capture('failure'); }
    catch (snapshotError) { snapshots.push({ label: 'failure-snapshot-error', message: snapshotError.message }); }
    const failures = await cleanup();
    error.jpegEventSetup = { stage, owner, preparation, snapshots, closed, cleanupErrors: failures, errors, external };
    console.error(JSON.stringify({ fixture: 'jpeg-event-setup-failure', error: { name: error.name, message: error.message }, ...error.jpegEventSetup }));
    throw error;
  }
}

function assertEventPixels(value, color) {
  const [red, green, blue] = value.pixel;
  assert(color === 'blue' ? blue > 240 && red < 20 : color === 'green' ? green > 100 && blue < 20 : red > 240 && blue < 20,
    `Expected ${color} native JPEG pixels: ${JSON.stringify(value)}`);
  assert.equal(value.sameVideo, true); assert.equal(value.videos, 1); assert.equal(value.nativeSeeks, 0);
  assert.equal(value.frame.session, value.session);
}

async function jpegEventSetupControls(browser, name) {
  const data = eventJpegData['fractional-origin-mapping'];
  for (const pausedEntry of [false, true]) {
    let entry;
    const v = await jpegEventViewer(browser, data, { beforePause: async ({ page, app }) => {
      entry = await page.evaluate(({ app, pausedEntry }) => {
        const replay = app.pageReplay, before = replay.paused, session = replay.session, frame = replay.decodedImage();
        if (before !== false) throw new Error('Playing-entry control must start playing');
        if (pausedEntry) replay.togglePause(); // Establish the prestate through one real production action.
        return { before, after: replay.paused, sameSession: replay.session === session,
          sameFrame: replay.decodedImage() === frame };
      }, { app, pausedEntry });
      assert.equal(entry.after, pausedEntry); assert.equal(entry.sameSession && entry.sameFrame, true);
    } });
    try {
      const value = await v.read(); assertEventPixels(value, 'green');
      assert.equal(v.preparation.before, pausedEntry); assert.equal(v.preparation.after, true);
      assert.equal(v.preparation.toggles, pausedEntry ? 0 : 1);
      assert.equal(v.preparation.sameSession && v.preparation.sameFrame && v.preparation.sameSource, true);
      assert.deepEqual(value.calls, []); assert.deepEqual(value.emits, []);
      assert.equal(value.frame.position, data.session.jpeg_frame.position); assert.equal(value.time, 1031.5);
      assert.equal(v.opens.length, 1); assert.equal(v.requests.filter(request => request.kind === 'image').length, 1);
      // Mismatched expected ownership must fail the actual guard without modifying any production state.
      assert.equal(await v.page.evaluate(jpegEventReady, { app: v.app,
        owner: { session: data.session.session_id, camera: 'wrong-camera' } }), false);
      console.log(JSON.stringify({ browser: name, case: 'jpeg-setup-entry', pausedEntry, entry, preparation: v.preparation, value }));
    } finally { await v.close(); }
  }
  for (const control of ['held-image', 'wrong-owner']) {
    let preparationCalls = 0, failure;
    try {
      await jpegEventViewer(browser, data, { holdImage: control === 'held-image',
        owner: { session: control === 'wrong-owner' ? 'f'.repeat(32) : data.session.session_id, camera: data.session.camera_id },
        beforePause: () => { preparationCalls++; } });
      assert.fail('Invalid native setup must not complete');
    } catch (error) { failure = error; }
    assert.match(failure.message, /Timeout 10000ms exceeded/);
    const setup = failure.jpegEventSetup;
    assert.equal(setup.stage, 'initial-owned-native'); assert.equal(preparationCalls, 0);
    assert.equal(setup.preparation, undefined); assert.deepEqual(setup.closed, { handle: true, context: true, server: true });
    assert.deepEqual(setup.cleanupErrors, []); assert.deepEqual(setup.errors, []); assert.deepEqual(setup.external, []);
    const state = setup.snapshots.at(-1).state;
    if (control === 'held-image') {
      assert.equal(state.frame, null); assert.equal(state.image.width, 0);
    } else {
      assert.equal(state.frame.session, data.session.session_id); assert.notEqual(state.frame.session, setup.owner.session);
      assert.equal(state.image.complete, true); assert.equal(state.image.width, 64);
    }
    console.log(JSON.stringify({ browser: name, case: 'jpeg-setup-guard', control,
      error: { name: failure.name, message: failure.message }, setup }));
  }
}

async function preciseJpegEvents(engine, name) {
  const browser = await engine.launch({ headless: true });
  try {
    const v = await jpegEventViewer(browser, eventJpegData.tail.initial);
    try {
      const initial = await v.read(); assertEventPixels(initial, 'blue');
      assert.equal(initial.time, 1002); assert.equal(initial.state, 'RUNNING');
      assert.equal(initial.groups.length, 0); assert.equal(initial.summaries.length, 1);
      assert.equal(initial.summaries[0].id, '1002.5:paused');
      const pending = await v.page.evaluate(({ app }) => {
        const markers = document.querySelector('#timeline-events'), replay = app.pageReplay;
        const owner = replay.session, modelOwner = markers.history.session, metadata = JSON.stringify(owner);
        const calls = window.eventCalls.length, emits = window.eventEmits.length;
        markers.seek({ id: '1002.5:paused', position: 2.5 });
        return { calls: window.eventCalls.length - calls, emits: window.eventEmits.length - emits,
          sameOwner: owner === replay.session && modelOwner === markers.history.session && metadata === JSON.stringify(owner) };
      }, { app: v.app });
      assert.deepEqual(pending, { calls: 0, emits: 0, sameOwner: true });
      v.publish(eventJpegData.tail.completed);
      await v.wait(({ app }) => app.pageReplay.session.jpeg_frame.position === 30 && document.querySelector('#timeline-events').groups.length === 1);
      const markers = v.page.locator('#timeline-events');
      await markers.locator('.timeline-event').click();
      await v.wait(({ app }) => app.pageReplay.decodedImage()?.position === 2.5);
      const pointer = await v.read(); assertEventPixels(pointer, 'blue');
      assert.equal(pointer.time, 1002.5); assert.equal(pointer.state, 'PAUSE'); assert.equal(pointer.statsState, 'PAUSE');
      assert.deepEqual(pointer.calls, [2.5]); assert.deepEqual(pointer.emits, [{ id: '1002.5:paused', position: 2.5 }]);
      assert.equal(pointer.session, initial.session);
      await markers.locator('.timeline-event').focus(); await v.page.keyboard.press('Enter');
      const keyboard = await v.read();
      assert.deepEqual(keyboard.calls, [2.5, 2.5]); assert.equal(keyboard.emits.length, 2);
      const requestCount = v.requests.length;
      await markers.locator('.timeline-event').hover();
      await v.page.evaluate(() => document.querySelector('#timeline-events').render());
      assert.equal(v.requests.length, requestCount, 'Render and hover make no additional history/media request');
      const controls = await v.page.evaluate(({ app }) => {
        const replay = app.pageReplay, markers = document.querySelector('#timeline-events'), model = markers.history, slider = replay.slider;
        const owner = replay.session, modelOwner = model.session, original = JSON.stringify(owner), originalEvents = structuredClone(model.events);
        const result = {}, count = () => [window.eventCalls.length, window.eventEmits.length];
        const freeze = (start, end) => { replay.scrubbing = true; slider.min = start; slider.max = end; slider.disabled = false; };
        const difference = before => count().map((value, index) => value - before[index]);
        freeze(0, 30); markers.render();
        result.mapping = { fraction: markers.groups[0].fraction, edge: replay.timeline.edge,
          label: markers.querySelector('button').getAttribute('aria-label') };
        // Cached renderer coordinates are not authority for activation.
        markers.groups[0].events[0].position = -99;
        const fresh = count(); markers.querySelector('button').click();
        result.fresh = { difference: difference(fresh), target: window.eventCalls.at(-1), emit: window.eventEmits.at(-1).position };
        freeze(0, 30); markers.render();
        freeze(10, 30); const stale = count(); markers.querySelector('button').click();
        result.staleButton = difference(stale);
        // A real connected grouped menu can outlive its current display window.
        model.events.push({ id: '1002.75:resumed', at: 1002.75, type: 'resumed', label: 'Print resumed' });
        freeze(0, 30); markers.render(); markers.querySelector('button').click();
        const menu = markers.querySelector('[data-event]');
        freeze(10, 30); const staleMenu = count(); menu.click(); result.staleMenu = difference(staleMenu);
        markers.closeMenu(); markers.render(); result.offscreen = { groups: markers.groups.length, summaries: model.events.length };
        freeze(0, 30); markers.render(); result.revealed = markers.groups.flatMap(group => group.events.map(event => event.id));
        // Inclusive actual bounds; these are model summaries, not extra inferred transitions.
        model.events = [{ id: 'lower', at: 1000, type: 'started', label: 'Lower' }, { id: 'upper', at: 1030, type: 'finished', label: 'Upper' }];
        freeze(0, 30); markers.render(); result.inclusive = markers.groups.flatMap(group => group.events.map(event => event.position));
        // An older raw descriptor must not override the accepted sequence guard.
        replay.jpegDescriptor(); const accepted = replay.imageDescriptor;
        replay.session = { ...owner, jpeg_frame: { ...owner.jpeg_frame, sequence: 0, position: 1 } };
        result.staleDescriptorEnd = markers.localJpegEvents(replay, slider).session.end_seconds;
        replay.session = owner; replay.imageDescriptor = accepted;
        // Other modes retain legacy session-wide activation even outside display.
        model.events = originalEvents;
        for (const mode of ['descriptorless', 'invalid', 'hls', 'file', 'remote']) {
          replay.session = structuredClone(owner);
          if (mode === 'descriptorless') delete replay.session.jpeg_frame;
          if (mode === 'invalid') replay.session.jpeg_frame.sequence = -1;
          if (mode === 'hls' || mode === 'file') replay.session.kind = mode;
          if (mode === 'remote') replay.remote = {};
          freeze(0, 30); markers.render();
          const legacyEvent = markers.groups.flatMap(group => group.events)[0];
          freeze(10, 30);
          const seek = replay.seek; let target = null; replay.seek = value => { target = value; };
          markers.seek(legacyEvent); replay.seek = seek;
          result[mode] = { local: markers.localJpegEvents(replay, slider) === null, target };
          replay.remote = null; replay.session = owner;
        }
        freeze(0, 30); markers.render(); slider.disabled = true;
        const disabled = count(); markers.seek({ id: originalEvents[0].id, position: 2.5 }); markers.render();
        result.disabled = { difference: difference(disabled), groups: markers.groups.length };
        slider.disabled = false;
        result.identity = owner === replay.session && modelOwner === model.session && original === JSON.stringify(owner);
        model.events = originalEvents; replay.scrubbing = false; replay.render();
        return result;
      }, { app: v.app });
      assert.equal(controls.mapping.fraction, 2.5 / 30);
      const behind = Math.floor(controls.mapping.edge - 2.5);
      assert.equal(controls.mapping.label, `Print paused, −${Math.floor(behind / 60)}:${String(behind % 60).padStart(2, '0')} from live`);
      assert.deepEqual(controls.fresh, { difference: [1, 1], target: 2.5, emit: 2.5 });
      assert.deepEqual(controls.staleButton, [0, 0]); assert.deepEqual(controls.staleMenu, [0, 0]);
      assert.deepEqual(controls.offscreen, { groups: 0, summaries: 2 }); assert.equal(controls.revealed.length, 2);
      assert.deepEqual(controls.inclusive, [0, 30]); assert.equal(controls.staleDescriptorEnd, 30);
      for (const mode of ['descriptorless', 'invalid', 'hls', 'file', 'remote']) assert.deepEqual(controls[mode], { local: true, target: 2.5 });
      assert.deepEqual(controls.disabled, { difference: [0, 0], groups: 0 }); assert.equal(controls.identity, true);
      v.publish(eventJpegData.tail.retained);
      await v.wait(({ app }) => app.pageReplay.session.jpeg_frame.start === 30);
      assert.equal((await v.read()).summaries.length, 0, 'Actual recorder byte pruning removes genuinely expired summaries');
      assert.equal(v.opens.length, 1);
      console.log(JSON.stringify({ browser: name, case: 'jpeg-event-coverage', initial, pointer, controls, requests: v.requests.length }));
    } finally { await v.close(); }
    for (const key of ['fractional-origin-mapping', 'fractional-anchor-retention']) {
      const data = eventJpegData[key], v = await jpegEventViewer(browser, data);
      try {
        const before = await v.read(); assertEventPixels(before, 'green');
        assert.equal(before.summaries.length, 1); assert.equal(before.groups.length, 1);
        assert.equal(before.groups[0].events[0].position, data.target);
        const identity = await v.page.evaluate(({ app }) => {
          const markers = document.querySelector('#timeline-events'), owner = app.pageReplay.session, modelOwner = markers.history.session, original = JSON.stringify(owner);
          markers.render();
          return owner === app.pageReplay.session && modelOwner === markers.history.session && original === JSON.stringify(owner);
        }, { app: v.app });
        assert.equal(identity, true);
        await v.page.locator('#timeline-events .timeline-event').click();
        await v.wait(({ app }) => app.pageReplay.decodedImage()?.position === window.eventCalls.at(-1));
        const after = await v.read(); assertEventPixels(after, 'blue');
        assert.equal(after.time, 1030.124); assert.equal(after.state, 'PAUSE'); assert.equal(after.statsState, 'PAUSE');
        assert.deepEqual(after.calls, [data.target]); assert.deepEqual(after.emits, [{ id: '1030.124:paused', position: data.target }]);
        assert.equal(after.summaries.length, 1); assert.equal(after.session, before.session); assert.equal(v.opens.length, 1);
        console.log(JSON.stringify({ browser: name, case: key, before, after, identity }));
      } finally { await v.close(); }
    }
    await jpegEventSetupControls(browser, name);
  } finally { await browser.close(); }
}

for (const [name, engine] of Object.entries({ chromium, webkit })) {
  if (selected && selected !== name) continue;
  await preciseJpegEvents(engine, name);
}
