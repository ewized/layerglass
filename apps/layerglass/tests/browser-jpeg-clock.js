import { fixtureAsset } from './fixture-assets.js';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import { chromium, webkit } from 'playwright';

const fixture = JSON.parse(await fs.readFile(new URL('./fixtures/jpeg-clock.json', import.meta.url), 'utf8'));
const source = new URL('../src/', import.meta.url);
const servers = new Set();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, message) {
  const deadline = Date.now() + 6000;
  while (!predicate()) { assert(Date.now() < deadline, message); await pause(20); }
}

async function viewer(browser, cadence = 'subsecond', { original = false, recording = true, legacy: initialLegacy = false } = {}) {
  const data = fixture.scenarios[cadence], streams = new Map(), requests = [], opens = [], held = [];
  let phase = 'gap', metadataPhase = null, legacy = initialLegacy, gate = null;
  const entry = (camera, token) => camera === fixture.other_camera ? data.other : data.phases[phase][
    token === data.phases.gap.replacement.replay.session_id ? 'replacement' : original ? 'original' : 'later'];
  const catalog = { default_camera_id: fixture.camera, cameras: [fixture.camera, fixture.other_camera].map(id => ({
    id, name: 'Generated JPEG fixture', model_name: 'Generated JPEG fixture', model: 'A1',
    configured: true, discovered: true, serial: 'GENERATED-FIXTURE', host: 'fixture.invalid', port: 6000,
  })), discovery: { state: 'done', networks: [], checked: 0, total: 0, cached: 0 } };
  const state = (camera = fixture.camera, token = null) => {
    const value = entry(camera, token);
    const status = { camera_id: camera, state: 'live', generation: 'a'.repeat(32),
      jpeg_url: `/api/cameras/${camera}/frame.jpg`, printer: value.telemetry.samples.at(-1).printer, message: 'Generated JPEG fixture' };
    if (!token) return { version: 1, catalog, status };
    let replay = value.replay;
    if (metadataPhase && camera === fixture.camera) {
      replay = data.phases[metadataPhase][token === data.phases.gap.replacement.replay.session_id ? 'replacement' : original ? 'original' : 'later'].replay;
    }
    if (legacy) { replay = { ...replay }; delete replay.jpeg_frame; }
    return { version: 1, catalog, status, session_id: token, replay, telemetry: value.telemetry };
  };
  const publish = () => { for (const [response, value] of streams) response.write('event: state\ndata: ' + JSON.stringify(state(value.camera, value.token)) + '\n\n'); };
  const json = (response, value, status = 200) => response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
  const image = (response, color) => {
    if (!response.destroyed && !response.writableEnded) response.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' }).end(Buffer.from(fixture.colors[color], 'base64'));
  };
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://fixture.invalid');
    if (url.pathname === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html' }).end(`<!doctype html><html><head>
        <meta name="layerglass-backend" content="python"><meta name="viewport" content="width=device-width,initial-scale=1">
        <link rel="stylesheet" href="/static/style.css"></head><body>
        <printer-player id="player" class="player" tabindex="0"></printer-player>
        <script type="module" src="/static/player.js"></script></body></html>`); return;
    }
    if (url.pathname === '/api/events') {
      const camera = url.searchParams.get('camera') || fixture.camera, token = url.searchParams.get('session');
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
      streams.set(response, { camera, token }); response.on('close', () => streams.delete(response));
      response.write('event: state\ndata: ' + JSON.stringify(state(camera, token)) + '\n\n'); return;
    }
    if (url.pathname === '/api/sessions' && request.method === 'POST') {
      let body = ''; for await (const chunk of request) body += chunk;
      if (!recording) { json(response, { error: 'Generated recording unavailable' }, 503); return; }
      const camera = JSON.parse(body).camera_id;
      const prior = opens.filter(value => value.camera === camera).length;
      const value = camera === fixture.other_camera ? data.other : data.phases[phase][prior ? 'replacement' : original ? 'original' : 'later'];
      opens.push({ camera, token: value.replay.session_id }); json(response, state(camera, value.replay.session_id).replay); return;
    }
    if (url.pathname === '/api/cameras') { json(response, catalog); return; }
    if (url.pathname === '/api/status') { json(response, state(url.searchParams.get('camera') || fixture.camera).status); return; }
    if (url.pathname === '/api/snapshot') { json(response, state(url.searchParams.get('camera') || fixture.camera, url.searchParams.get('session'))); return; }
    if (url.pathname.endsWith('/close')) { json(response, {}); return; }
    if (url.pathname.endsWith('/printer')) {
      const token = url.pathname.split('/')[3], camera = token === data.other.replay.session_id ? fixture.other_camera : fixture.camera;
      json(response, entry(camera, token).telemetry); return;
    }
    if (url.pathname.endsWith('/frame.jpg')) {
      const token = url.pathname.startsWith('/replay/') ? url.pathname.split('/')[2] : null;
      const camera = token === data.other.replay.session_id || url.pathname.includes(fixture.other_camera) ? fixture.other_camera : fixture.camera;
      const value = entry(camera, token), frames = value.frames;
      const frame = url.searchParams.has('frame') ? Number(url.searchParams.get('frame')) : null;
      const at = url.searchParams.has('at') ? Number(url.searchParams.get('at')) : null;
      const covered = frame === null ? frames : frames.filter(item => item.sequence <= frame);
      if (!covered.length || frame !== null && covered.at(-1).sequence !== frame ||
          frame !== null && at !== null && (at < Math.max(0, covered[0].position) || at > covered.at(-1).position)) {
        response.writeHead(404).end(); return;
      }
      const selected = at === null ? covered.at(-1) : covered.findLast(item => item.position <= at) || covered[0];
      const info = { camera, token, frame, at, phase, color: selected.color, time: Date.now() };
      requests.push(info);
      if (gate?.(info)) { held.push({ info, response }); return; }
      image(response, selected.color); return;
    }
    const file = fixtureAsset(url.pathname);
    if (file) {
      try { response.writeHead(200, { 'Content-Type': file.pathname.endsWith('.css') ? 'text/css' : 'text/javascript' }).end(await fs.readFile(file)); }
      catch { response.writeHead(404).end(); }
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  servers.add(server);
  const origin = 'http://127.0.0.1:' + server.address().port;
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'onLine', { get: () => true });
    const decode = HTMLImageElement.prototype.decode;
    HTMLImageElement.prototype.decode = function() {
      const native = decode.call(this);
      if (this.id === 'jpeg' && window.holdNextJpegDecode && this.src.startsWith('blob:')) {
        window.holdNextJpegDecode = false;
        return native.then(() => new Promise(resolve => { window.releaseJpegDecode = resolve; }));
      }
      return native;
    };
  });
  const page = await context.newPage(), errors = [], external = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    external.push(route.request().url()); return route.abort();
  });
  await page.goto(origin);
  const app = await page.evaluateHandle(() => import('/static/player.js'));
  const wait = (predicate, timeout = 10000) => page.waitForFunction(predicate, { app }, { timeout });
  await wait(({ app }) => document.querySelector('#jpeg').naturalWidth > 0 && document.querySelector('#overlay').hidden &&
    (!app.pageReplay.session || !app.pageReplay.attaching));
  await page.evaluate(({ app }) => {
    window.originalVideo = app.video; window.commits = 0; window.nativeSeeks = 0;
    window.addEventListener('replaypositionchange', () => window.commits++);
    app.video.addEventListener('seeked', () => window.nativeSeeks++);
    app.playerTools.stats.show(true);
  }, { app });
  const read = () => page.evaluate(async ({ app }) => {
    const { printerPlaybackTime } = await import('/static/printer-history.js');
    const image = document.querySelector('#jpeg'), canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 36;
    const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
    app.playerTools.stats.renderStats();
    return { position: app.pageReplay.position, imagePosition: app.pageReplay.decodedImage?.()?.position,
      time: printerPlaybackTime(app.video, app.hls, app.pageReplay), paused: app.pageReplay.paused, live: app.pageReplay.followLive,
      layer: app.playerTools.stats.querySelector('[data-stat-key="layer"]')?.textContent,
      pixel: [...context.getImageData(32, 18, 1, 1).data], session: app.pageReplay.session?.session_id ?? null,
      previews: [...app.previewHistory.frames.values()].map(frame => ({ time: frame.time, bucket: frame.bucket })),
      sameVideo: window.originalVideo === app.video, videos: document.querySelectorAll('video').length, seeks: window.nativeSeeks,
      commits: window.commits, source: image.getAttribute('src'), loading: app.pageReplay.imageLoading };
  }, { app });
  return { page, app, wait, read, data, requests, opens, held, errors, external,
    phase(name, override = null) { phase = name; metadataPhase = override; publish(); },
    legacy() { legacy = true; publish(); },
    gate(predicate) { gate = predicate; },
    release(value) { image(value.response, value.info.color); },
    async close() {
      await app.dispose(); await context.close(); for (const value of held) value.response.destroy();
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      servers.delete(server);
      assert.deepEqual(errors, []); assert.deepEqual(external, []);
    } };
}

function color(value, name) {
  const [red, green, blue] = value.pixel;
  assert(name === 'blue' ? blue > 240 && red < 20 : name === 'green' ? green > 100 && blue < 20 :
    name === 'yellow' ? red > 240 && green > 240 && blue < 20 : red > 240 && blue < 20,
  `Expected ${name} decoded pixels, got ${value.pixel}`);
  assert(value.sameVideo); assert.equal(value.videos, 1); assert.equal(value.seeks, 0);
}

async function pauseClock(browser, engine, cadence) {
  const v = await viewer(browser, cadence);
  try {
    await v.page.getByRole('button', { name: 'Pause video', exact: true }).click();
    const before = await v.read();
    color(before, 'blue'); assert.equal(before.time, 1030); assert.equal(before.layer, '30');
    v.phase('next'); await v.wait(({ app }) => app.pageReplay.session.end_time > 1030);
    await v.page.waitForTimeout(1050);
    const after = await v.read();
    color(after, 'blue');
    assert.equal(after.layer, before.layer, 'A fixed paused blue JPEG must retain its rendered recorded Stats reading');
    assert.equal(after.time, before.time, 'New metadata cannot move the recorded clock of fixed paused pixels');
    assert.equal(before.position, 10); assert.equal(after.position, 10);
    assert.equal(after.session, before.session); assert.equal(v.opens.length, 1);
    assert(after.previews.some(frame => frame.time === 10), 'Captured thumbnail time belongs to decoded blue, not provisional11');
    v.phase('later'); await v.wait(({ app }) => app.pageReplay.session.end_time === 1031.5);
    await v.page.evaluate(({ app }) => app.pageReplay.seek(999), { app: v.app });
    await v.wait(({ app }) => app.pageReplay.decodedImage?.()?.position === 11.5);
    const provisional = await v.read(); color(provisional, 'yellow'); assert.equal(provisional.time, 1031.5);
    if (cadence === 'subsecond') {
      v.phase('precise'); await v.wait(({ app }) => app.pageReplay.session.end_time === 1032.123456);
      await v.page.evaluate(({ app }) => app.pageReplay.seek(999), { app: v.app });
      const exact = v.data.phases.precise.later.replay.jpeg_frame.position;
      await v.wait(({ app }) => app.pageReplay.decodedImage?.()?.time === 1032.123456);
      const precise = await v.read(); color(precise, 'red'); assert.equal(precise.imagePosition, exact); assert.equal(precise.time, 1032.123456);
      const count = v.requests.length, commits = precise.commits;
      await v.page.evaluate(({ app }) => {
        const slider = app.pageReplay.slider;
        slider.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 8, button: 0, isPrimary: true }));
        for (const value of [10.1, 10.8, 11.3]) { slider.value = value; slider.dispatchEvent(new Event('input', { bubbles: true })); }
      }, { app: v.app });
      assert.equal(v.requests.length, count); assert.equal((await v.read()).commits, commits);
      await v.page.evaluate(() => window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 8, isPrimary: true })));
      await v.wait(({ app }) => app.pageReplay.decodedImage?.()?.position === 11.3);
      const committed = await v.read(); color(committed, 'green'); assert.equal(committed.time, 1031.3);
      assert.equal(v.requests.length, count + 1); assert.equal(committed.commits, commits + 1);
      for (const kind of ['keyboard', 'wheel']) {
        const prior = v.requests.length;
        await v.page.evaluate(({ app, kind }) => {
          const slider = app.pageReplay.slider;
          if (kind === 'keyboard') {
            slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
            for (const value of [11.1, 10.8, 10.4]) { slider.value = value; slider.dispatchEvent(new Event('input', { bubbles: true })); }
          } else for (let index = 0; index < 3; index++) slider.dispatchEvent(new WheelEvent('wheel', { deltaX: 5, cancelable: true }));
        }, { app: v.app, kind });
        assert.equal(v.requests.length, prior);
        if (kind === 'keyboard') await v.page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowLeft' })));
        await until(() => v.requests.length === prior + 1, 'One committed JPEG gesture request');
        await v.wait(({ app }) => !app.pageReplay.imageRequest);
      }
      // Exercise the existing same-session JPEG attach/detach/readiness path
      // with real fetching and decoding, without inventing a transport fault.
      const selected = await v.read(), prior = v.requests.length;
      await v.page.evaluate(({ app }) => {
        app.pageReplay.attachMedia({ preserve: true }); app.pageReplay.clearImage();
        document.querySelector('#jpeg').removeAttribute('src'); app.pageReplay.mediaReady();
      }, { app: v.app });
      await v.wait(({ app }) => Boolean(app.pageReplay.decodedImage?.()) && !app.pageReplay.attaching);
      const restored = await v.read(); assert.equal(restored.paused, true); assert.equal(restored.time, selected.time);
      assert.equal(restored.imagePosition, selected.imagePosition); assert.equal(restored.session, selected.session); assert.equal(v.requests.length, prior + 1);
    }
    await v.page.getByRole('button', { name: 'Return to live video', exact: true }).click();
    await v.wait(({ app }) => app.pageReplay.followLive && !app.pageReplay.paused &&
      app.pageReplay.decodedImage?.()?.time === app.pageReplay.jpegDescriptor?.()?.time);
    color(await v.read(), cadence === 'subsecond' ? 'red' : 'yellow');
    console.log(JSON.stringify({ engine, cadence, before, after, opens: v.opens.length, requests: v.requests.length }));
  } finally { await v.close(); }
}

async function ownershipRaces(browser, engine) {
  const v = await viewer(browser);
  try {
    const token = (await v.read()).session;
    v.gate(info => info.token === token && info.frame >= 2);
    v.phase('next'); await until(() => v.held.length > 0, 'Hold green JPEG body');
    v.phase('later'); await v.wait(({ app }) => app.pageReplay.session.end_time === 1031.5);
    const pending = await v.read(); color(pending, 'blue'); assert.equal(pending.time, 1030);
    assert.equal(pending.imagePosition, 10, 'Old owned pixels/time stay paired before the held green body finishes');
    v.release(v.held[0]);
    await v.wait(({ app }) => app.pageReplay.decodedImage?.()?.time === 1030.25);
    const green = await v.read(); color(green, 'green'); assert.equal(green.time, 1030.25, 'Later metadata cannot relabel a held green body');
    await v.page.getByRole('button', { name: 'Pause video', exact: true }).click();
    v.phase('later', 'gap'); await v.page.waitForTimeout(200);
    color(await v.read(), 'green'); assert.equal((await v.read()).time, 1030.25, 'Older metadata cannot replace a newer owned clock');
    v.gate(null);
    await v.page.getByRole('button', { name: 'Return to live video', exact: true }).click();
    await v.wait(({ app }) => app.pageReplay.decodedImage?.()?.time === 1031.5);
    color(await v.read(), 'yellow');
    v.phase('precise'); await v.wait(({ app }) => app.pageReplay.session.end_time === 1032.123456);
    await v.page.evaluate(() => { window.holdNextJpegDecode = true; });
    await v.wait(() => Boolean(window.releaseJpegDecode));
    const decoding = await v.read(); color(decoding, 'red');
    assert.equal(decoding.time, null, 'Uncommitted newly decoded pixels cannot acquire the prior or latest metadata clock');
    const requestCount = v.requests.length;
    await v.page.getByRole('button', { name: 'Pause video', exact: true }).click();
    await v.wait(({ app }) => !app.pageReplay.imageLoading);
    const frozen = await v.read(); color(frozen, 'yellow'); assert.equal(frozen.time, 1031.5);
    await v.page.evaluate(() => window.releaseJpegDecode()); await v.page.waitForTimeout(200);
    color(await v.read(), 'yellow'); assert.equal(v.requests.length, requestCount, 'Restoring an owned Blob does not refetch it');
    // A pending old session may not mutate an expired/replacement session.
    v.gate(info => info.token === token && info.frame === 4);
    await v.page.getByRole('button', { name: 'Return to live video', exact: true }).click();
    await until(() => v.held.some(value => value.info.frame === 4), 'Hold old-session precise capture');
    await v.page.evaluate(({ app }) => {
      window.originalSession = app.pageReplay.session.session_id;
      app.pageReplay.updateMetadata(app.pageReplay.session.session_id, null);
    }, { app: v.app });
    await v.wait(({ app }) => app.pageReplay.session?.session_id !== window.originalSession && Boolean(app.pageReplay.decodedImage?.()));
    const replacement = await v.read(); assert.notEqual(replacement.session, token); color(replacement, 'red');
    for (const value of v.held) v.release(value);
    await v.page.waitForTimeout(200); assert.equal((await v.read()).session, replacement.session); color(await v.read(), 'red');
    // Camera replacement uses the actual player selection path and same video.
    v.phase('precise');
    await v.page.evaluate(({ app }) => {
      app.pageReplay.seek(10.2);
    }, { app: v.app });
    await v.wait(({ app }) => app.pageReplay.decodedImage?.()?.position === 10.2);
    v.gate(info => info.token === replacement.session && info.frame === 4);
    await v.page.getByRole('button', { name: 'Return to live video', exact: true }).click();
    await until(() => v.held.some(value => value.info.token === replacement.session), 'Hold old-camera image');
    await v.page.evaluate(camera => document.querySelector('#camera-list').dispatchEvent(new CustomEvent('printer-select', { detail: { cameraId: camera } })), fixture.other_camera);
    await v.wait(({ app }) => app.pageReplay.session?.camera_id === 'fedcba0987654321' && Boolean(app.pageReplay.decodedImage?.()));
    const other = await v.read(); color(other, 'red'); assert.equal(other.time, 1040); assert.equal(other.layer, '40');
    for (const value of v.held) v.release(value);
    await v.page.waitForTimeout(200); assert.equal((await v.read()).session, other.session); assert.equal(v.opens.length, 3);
    console.log(JSON.stringify({ engine, scenario: 'JPEG body/metadata/decode/session/camera ownership', pending, green, decoding, frozen, replacement, other }));
  } finally { await v.close(); }
}

async function pendingIntent(browser, engine) {
  const v = await viewer(browser);
  try {
    const token = (await v.read()).session;
    v.gate(info => info.token === token && info.frame === 2);
    v.phase('next'); await until(() => v.held.length > 0, 'Hold next JPEG for pause');
    await v.page.getByRole('button', { name: 'Pause video', exact: true }).click();
    const frozen = await v.read(); color(frozen, 'blue'); assert.equal(frozen.time, 1030); assert.equal(frozen.position, 10);
    v.release(v.held[0]); await v.page.waitForTimeout(200);
    color(await v.read(), 'blue'); assert.equal((await v.read()).time, 1030);
    v.gate(null);
    await v.page.getByRole('button', { name: 'Play buffered video', exact: true }).click();
    await v.wait(({ app }) => app.pageReplay.decodedImage?.()?.time === 1030.25 && !app.pageReplay.paused);
    const resumed = await v.read(); color(resumed, 'green'); assert.equal(resumed.live, false);
    await v.page.getByRole('button', { name: 'Pause video', exact: true }).click();
    v.gate(info => info.token === token && info.at === 10.1);
    await v.page.evaluate(({ app }) => app.pageReplay.seek(10.1), { app: v.app });
    await until(() => v.held.some(value => value.info.at === 10.1), 'Hold historical JPEG for explicit Live');
    const selected = await v.read(); color(selected, 'green'); assert.equal(selected.time, 1030.25);
    await v.page.getByRole('button', { name: 'Return to live video', exact: true }).click();
    await v.wait(({ app }) => app.pageReplay.followLive && !app.pageReplay.imageRequest && app.pageReplay.decodedImage?.()?.time === 1030.25);
    for (const value of v.held) v.release(value);
    await v.page.waitForTimeout(200);
    const live = await v.read(); color(live, 'green'); assert.equal(live.live, true); assert.equal(live.time, 1030.25);
    assert.equal(v.opens.length, 1);
    console.log(JSON.stringify({ engine, scenario: 'pause/play/Live with pending JPEG bodies', frozen, resumed, selected, live }));
  } finally { await v.close(); }
}

async function compatibility(browser, engine) {
  const v = await viewer(browser, 'subsecond', { original: true });
  try {
    await v.page.getByRole('button', { name: 'Pause video', exact: true }).click();
    await v.page.evaluate(({ app }) => app.pageReplay.seek(5.125678), { app: v.app });
    await v.wait(({ app }) => app.pageReplay.decodedImage?.()?.position === 5.125678);
    const held = await v.read(); color(held, 'red'); assert.equal(held.time, 1005.125678);
    v.phase('later'); await v.page.waitForTimeout(100);
    assert.equal((await v.read()).time, held.time);
    v.legacy(); await v.page.getByRole('button', { name: 'Return to live video', exact: true }).click();
    await v.wait(({ app }) => !app.pageReplay.imageFrame && document.querySelector('#jpeg').currentSrc.startsWith('http'));
    const legacy = await v.read(); color(legacy, 'yellow'); assert.equal(legacy.time, null); assert.equal(legacy.layer, '—');
    await v.page.evaluate(({ app }) => app.pageReplay.seek(5), { app: v.app });
    await v.wait(() => document.querySelector('#jpeg').complete);
    color(await v.read(), 'red'); assert.equal((await v.read()).time, null);
    console.log(JSON.stringify({ engine, scenario: 'completed hold and compatible unowned legacy JPEG', held, legacy }));
  } finally { await v.close(); }
  const live = await viewer(browser, 'subsecond', { recording: false });
  try {
    const result = await live.read(); color(result, 'blue'); assert.equal(result.session, null); assert.equal(result.time, null);
    assert.equal(result.previews.length, 0); console.log(JSON.stringify({ engine, scenario: 'no-recording Live fallback', result }));
  } finally { await live.close(); }
}

async function staleLifecycle(browser, engine) {
  const v = await viewer(browser);
  try {
    await v.page.getByRole('button', { name: 'Pause video', exact: true }).click();
    const token = (await v.read()).session;
    v.phase('later'); await v.wait(({ app }) => app.pageReplay.session.end_time === 1031.5);
    v.gate(info => info.token === token && info.at === 10.1);
    await v.page.evaluate(({ app }) => app.pageReplay.seek(10.1), { app: v.app });
    await until(() => v.held.some(value => value.info.at === 10.1), 'Hold a historical blue body across a committed seek');
    await v.page.evaluate(({ app }) => app.pageReplay.seek(11.5), { app: v.app });
    await v.wait(({ app }) => app.pageReplay.decodedImage?.()?.position === 11.5);
    const selected = await v.read(); color(selected, 'yellow'); assert.equal(selected.time, 1031.5);
    v.release(v.held.find(value => value.info.at === 10.1)); await v.page.waitForTimeout(200);
    const afterSeek = await v.read(); color(afterSeek, 'yellow'); assert.equal(afterSeek.time, selected.time);
    assert.equal(afterSeek.imagePosition, selected.imagePosition);

    v.gate(info => info.token === token && info.at === 10.3);
    await v.page.evaluate(({ app }) => app.pageReplay.seek(10.3), { app: v.app });
    await until(() => v.held.some(value => value.info.at === 10.3), 'Hold an old body across same-session reattachment');
    v.gate(null);
    const requests = v.requests.length;
    await v.page.evaluate(({ app }) => {
      app.pageReplay.attachMedia({ preserve: true }); app.pageReplay.clearImage();
      document.querySelector('#jpeg').removeAttribute('src'); app.pageReplay.mediaReady();
    }, { app: v.app });
    await v.wait(({ app }) => app.pageReplay.decodedImage?.()?.position === 10.3 && !app.pageReplay.attaching);
    const restored = await v.read(); color(restored, 'green'); assert.equal(restored.time, 1030.3);
    assert.equal(restored.paused, true); assert.equal(restored.session, token); assert.equal(v.requests.length, requests + 1);
    v.release(v.held.find(value => value.info.at === 10.3)); await v.page.waitForTimeout(200);
    const afterRestore = await v.read(); color(afterRestore, 'green'); assert.equal(afterRestore.time, restored.time);
    assert.equal(afterRestore.imagePosition, restored.imagePosition);

    await v.page.evaluate(({ app }) => app.pageReplay.seek(11.5), { app: v.app });
    await v.wait(({ app }) => app.pageReplay.decodedImage?.()?.position === 11.5);
    await v.page.getByRole('button', { name: 'Play buffered video', exact: true }).click();
    await v.page.evaluate(({ app }) => {
      app.pageReplay.attachMedia({ preserve: true }); app.pageReplay.clearImage();
      document.querySelector('#jpeg').removeAttribute('src'); app.pageReplay.mediaReady();
    }, { app: v.app });
    await v.wait(({ app }) => Boolean(app.pageReplay.decodedImage?.()) && !app.pageReplay.attaching);
    const playing = await v.read(); color(playing, 'yellow'); assert.equal(playing.paused, false); assert.equal(playing.live, false);
    assert.equal(playing.session, token); assert.equal(playing.time, 1031.5); assert.equal(v.opens.length, 1);
    console.log(JSON.stringify({ engine, scenario: 'late bodies across committed seek and paused/playing same-session reattachment', selected, afterSeek, restored, afterRestore, playing }));
  } finally { await v.close(); }
}

async function legacyPause(browser, engine) {
  const v = await viewer(browser, 'subsecond', { original: true, legacy: true });
  try {
    const before = await v.read(), end = await v.page.evaluate(({ app }) => app.pageReplay.session.end_seconds, { app: v.app });
    color(before, 'blue'); assert.equal(before.time, null); assert.deepEqual(before.previews, []);
    await v.page.getByRole('button', { name: 'Pause video', exact: true }).click();
    const frozen = await v.read(); color(frozen, 'blue'); assert.equal(frozen.position, end, 'Fresh legacy Pause retains its Live archive position');
    assert.equal(frozen.time, null); assert.equal(frozen.paused, true); assert.deepEqual(frozen.previews, []);
    const prior = v.requests.length;
    await v.page.getByRole('button', { name: 'Play buffered video', exact: true }).click();
    await until(() => v.requests.length > prior, 'Legacy Play requests the selected archive frame');
    await v.wait(() => {
      const image = document.querySelector('#jpeg');
      return image.complete && image.currentSrc === image.src && image.currentSrc.includes('/replay/');
    });
    const resumed = await v.read(); color(resumed, 'blue'); assert.equal(resumed.position, end);
    assert.equal(v.requests[prior].at, Math.floor(end * 2) / 2, 'Legacy Play must not jump back to the first red capture');
    assert.equal(resumed.time, null); assert.equal(resumed.paused, false); assert.equal(resumed.live, false);
    assert.deepEqual(resumed.previews, []); assert.equal(v.opens.length, 1);
    await v.page.evaluate(({ app }) => {
      app.pageReplay.seek(5.125); app.pageReplay.togglePause();
    }, { app: v.app });
    await v.wait(() => {
      const image = document.querySelector('#jpeg'); return image.complete && image.currentSrc === image.src;
    });
    const historical = await v.read(); color(historical, 'red');
    assert.equal(historical.position, 5.125, 'Pausing already-playing legacy history keeps its selected past');
    assert.equal(historical.paused, true); assert.equal(historical.time, null); assert.deepEqual(historical.previews, []);
    const historicalPrior = v.requests.length;
    await v.page.getByRole('button', { name: 'Play buffered video', exact: true }).click();
    await until(() => v.requests.length > historicalPrior, 'Historical legacy playback progresses after Play');
    await v.wait(() => {
      const image = document.querySelector('#jpeg'); return image.complete && image.currentSrc === image.src;
    });
    const historicalResumed = await v.read(); color(historicalResumed, 'red');
    assert(historicalResumed.position > historical.position && historicalResumed.position < 10);
    assert.equal(historicalResumed.paused, false); assert.equal(historicalResumed.live, false);
    assert.equal(historicalResumed.time, null); assert.deepEqual(historicalResumed.previews, []); assert.equal(v.opens.length, 1);
    console.log(JSON.stringify({ engine, scenario: 'fresh legacy Live and historical Pause/Play', before, frozen, resumed, firstResumeRequest: v.requests[prior], historical, historicalResumed, opens: v.opens.length }));
  } finally { await v.close(); }
}

async function legacyWheel(browser, engine) {
  const v = await viewer(browser, 'subsecond', { original: true, legacy: true });
  try {
    await v.page.getByRole('button', { name: 'Pause video', exact: true }).click();
    const results = [];
    for (const [start, direction, expectedColor] of [[2, -1, 'red'], [29, 1, 'blue']]) {
      await v.page.evaluate(({ app, start }) => app.pageReplay.seek(start), { app: v.app, start });
      await v.wait(() => {
        const image = document.querySelector('#jpeg'); return image.complete && image.currentSrc === image.src;
      });
      const before = await v.read(), prior = v.requests.length;
      const preview = await v.page.evaluate(({ app, direction }) => {
        for (let index = 0; index < 3; index++) app.pageReplay.slider.dispatchEvent(new WheelEvent('wheel', { deltaX: direction * 100000, cancelable: true }));
        return { value: app.pageReplay.previewPosition, start: app.pageReplay.session.start_seconds, end: app.pageReplay.session.end_seconds };
      }, { app: v.app, direction });
      const expected = direction < 0 ? preview.start : preview.end - 0.05;
      assert.equal(preview.value, expected, 'Legacy wheel preview must stay inside actual archive bounds');
      assert.equal(v.requests.length, prior, 'Legacy wheel preview has no intermediate main-image request');
      await until(() => v.requests.length === prior + 1, 'One legacy wheel release request');
      await v.wait(({ app }) => {
        const image = document.querySelector('#jpeg'); return !app.pageReplay.scrubbing && image.complete && image.currentSrc === image.src;
      });
      const after = await v.read(); color(after, expectedColor);
      assert.equal(after.position, expected); assert.equal(after.commits, before.commits + 1);
      assert.equal(v.requests[prior].at, Math.floor(expected * 2) / 2);
      assert.equal(after.time, null); assert.deepEqual(after.previews, []); assert.equal(v.opens.length, 1);
      results.push({ before, preview, after, request: v.requests[prior] });
    }
    console.log(JSON.stringify({ engine, scenario: 'fresh legacy wheel lower and upper bounds', results }));
  } finally { await v.close(); }
}

const engines = Object.entries({ chromium, webkit }).filter(([engine]) => !process.env.JPEG_CLOCK_ENGINE || engine === process.env.JPEG_CLOCK_ENGINE);
assert(engines.length, 'Choose JPEG_CLOCK_ENGINE=chromium or webkit, or omit it for both.');
const scenario = process.env.JPEG_CLOCK_SCENARIO;
assert(!scenario || ['legacy-pause', 'legacy-wheel'].includes(scenario), 'Choose legacy-pause or legacy-wheel, or omit JPEG_CLOCK_SCENARIO for all controls.');
for (const [engine, launcher] of engines) {
  const browser = await launcher.launch({ headless: true, args: engine === 'chromium' ? ['--no-sandbox'] : [] });
  try {
    if (!scenario) {
      await pauseClock(browser, engine, 'subsecond'); await pauseClock(browser, engine, 'normal');
      await ownershipRaces(browser, engine); await pendingIntent(browser, engine); await staleLifecycle(browser, engine); await compatibility(browser, engine);
    }
    if (!scenario || scenario === 'legacy-pause') await legacyPause(browser, engine);
    if (!scenario || scenario === 'legacy-wheel') await legacyWheel(browser, engine);
  } finally {
    await browser.close();
    for (const server of servers) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); servers.delete(server); }
  }
}
console.log('JPEG clock: selected ownership and legacy compatibility controls passed in the requested engines.');
