import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import { installCastFixture } from './cast-fixture.js';

const fixture = JSON.parse(await fs.readFile(new URL('./fixtures/history-reconnect.json', import.meta.url), 'utf8'));
const source = new URL('../src/', import.meta.url);

async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert(Date.now() < deadline, 'The generated history request did not reach the fixture.');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

function pageHTML(engine) {
  return `<!doctype html><html><head><link rel="stylesheet" href="/static/style.css"></head><body>
<printer-player id="player" class="player" tabindex="0"></printer-player>
<script type="module">
import '/static/components/index.js';
import { PageReplay } from '/static/replay.js';
import { PrinterHistory } from '/static/printer-history.js';
import { GoogleCastSender } from '/static/cast-sender.js';
import { PlayerUpdates } from '/static/updates.js';
const player = document.querySelector('#player'), video = player.querySelector('video'), image = player.querySelector('#jpeg');
const stats = player.querySelector('#player-stats');
const replay = new PageReplay(video, image, () => 170);
replay.session = ${JSON.stringify(fixture.before.replay)};
const history = new PrinterHistory(() => stats.renderStats());
history.setSession(replay.session);
stats.configure({ player, video, image, readState: () => ({ replay, printerHistory: history,
  camera: { id: '${fixture.camera}', model_name: 'Generated fixture printer' }, discovery: { state: 'done' } }) });
let sender, move, castEligible;
if ('${engine}' === 'chromium') {
  const sdk = (${installCastFixture.toString()})(window);
  sdk.range = { start: 0, end: replay.session.end_seconds };
  sender = new GoogleCastSender(video, replay, () => ({ model: 'Fixture', id: '${fixture.camera}' }), () => {});
  sender.setSource('/replay/${fixture.session}/live.m3u8');
  await sender.initializing;
  if (!sender.ready) throw new Error('The Chromium fixture requires the supported Cast sender.');
  await sender.request();
  move = current => { sdk.range.end = replay.session.end_seconds; sdk.advance(current, true); };
  castEligible = sender.eligible;
} else {
  // WebKit has no Google Cast capability. Exercise the shared clock consumer
  // with an adapter rather than enabling a transport unsupported by the app.
  castEligible = new GoogleCastSender(video, replay, () => ({}), () => {}).eligible;
  if (castEligible) throw new Error('WebKit must remain Cast-ineligible.');
  let current = 20;
  sender = { paused: true, bounds: () => ({ start: 0, end: replay.session.end_seconds, current }),
    seek: value => { current = value; replay.position = value; }, togglePause() {} };
  replay.setRemote(sender);
  move = value => { current = value; replay.position = value; replay.render(); };
}
window.app = { player, video, stats, replay, history, sender, move, castEligible,
  states: 0, unavailable: 0, replayEvents: 0, nativeSeeks: 0 };
window.addEventListener('replaypositionchange', () => app.replayEvents++);
video.addEventListener('seeked', () => app.nativeSeeks++);
const updates = app.updates = new PlayerUpdates(state => {
  app.states++;
  if (Object.hasOwn(state, 'replay')) replay.updateMetadata(state.session_id, state.replay);
  if (state.telemetry) history.apply(state.telemetry, false);
}, () => app.unavailable++);
updates.subscribe('${fixture.camera}', '${fixture.session}');
window.ready = true;
</script></body></html>`;
}

async function scenario(browser, engine, mode) {
  const requests = [], connections = [], streams = new Set();
  let phase = 'before', held;
  const stateEvent = () => 'event: state\ndata: ' + JSON.stringify(fixture[phase]) + '\n\n';
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://fixture.invalid');
    if (url.pathname === '/api/events') {
      connections.push(phase);
      streams.add(response);
      response.on('close', () => streams.delete(response));
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
      response.write('retry: 100\n\n'); // Keep this generated reconnect bounded.
      response.write(stateEvent());
      return;
    }
    if (url.pathname.endsWith('/printer')) {
      requests.push({ at: Number(url.searchParams.get('at')), phase });
      if (phase === 'after') held = response;
      else response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(fixture.partial));
      return;
    }
    if (url.pathname === '/__advance') {
      phase = 'after';
      for (const stream of streams) stream.end();
      streams.clear();
      response.writeHead(200).end('ok');
      return;
    }
    if (url.pathname === '/') { response.writeHead(200, { 'Content-Type': 'text/html' }).end(pageHTML(engine)); return; }
    if (url.pathname.startsWith('/static/') && !url.pathname.includes('..')) {
      try {
        const body = await fs.readFile(new URL(url.pathname.slice('/static/'.length), source));
        response.writeHead(200, { 'Content-Type': url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript' }).end(body);
      } catch { response.writeHead(404).end(); }
      return;
    }
    // PageReplay releases its generated session on page exit.
    response.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const page = await browser.newPage({ serviceWorkers: 'block' });
  const errors = [], external = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    // This fixture remains reachable on loopback in a network-none container.
    Object.defineProperty(navigator, 'onLine', { get: () => true });
  });
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === origin) return route.continue();
    external.push(url.href);
    return route.abort();
  });
  try {
    await page.goto(origin);
    await page.waitForFunction(() => window.ready && app.states === 1);
    assert.equal(await page.evaluate(() => app.castEligible), engine === 'chromium');
    await page.evaluate(() => { app.move(20); app.stats.show(true); });
    await page.waitForFunction(() => app.history.pending === null && app.history.peek(1220)?.progress === 20);
    assert.deepEqual(requests, [{ at: 1220, phase: 'before' }]);
    assert.equal(await page.locator('[data-stat-key="progress"]').textContent(), '20%');
    await page.evaluate(() => {
      // Negative model control: this point is not recorded yet, so repeated
      // reads must not request it. The receiver remains inside its real bounds.
      for (let i = 0; i < 60; i++) { app.history.read(1280); app.stats.renderStats(); }
    });
    assert.equal(requests.length, 1);
    await page.evaluate(() => fetch('/__advance'));
    await page.waitForFunction(() => app.states === 2 && app.updates.streaming);
    assert.deepEqual(connections, ['before', 'after']);
    if (mode === 'receiver') await page.evaluate(() => app.move(80));
    else await page.evaluate(() => { app.move(20); app.replay.seek(80); });
    // Let the real Stats timer initiate receiver recovery; do not synthesize a
    // local seek or call history.load/retry in the receiver scenario.
    await page.waitForFunction(() => app.history.pending === 10, undefined, { timeout: 5000 });
    await until(() => requests.length === 2);
    assert.deepEqual(requests, [{ at: 1220, phase: 'before' }, { at: 1280, phase: 'after' }]);
    await page.evaluate(() => { for (let i = 0; i < 60; i++) app.stats.renderStats(); });
    assert.equal(requests.length, 2, 'Pending hydration must coalesce all render reads.');
    assert(held);
    held.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(fixture.full));
    held = null;
    await page.waitForFunction(() => app.history.pending === null && app.history.peek(1280)?.progress === 80);
    assert.equal(await page.locator('[data-stat-key="progress"]').textContent(), '80%');
    const events = await page.evaluate(() => ({ replay: app.replayEvents, native: app.nativeSeeks, unavailable: app.unavailable,
      remote: app.replay.remote === app.sender, position: app.replay.bounds().current }));
    assert.deepEqual(events, { replay: mode === 'receiver' ? 0 : 1, native: 0, unavailable: 1, remote: true, position: 80 });
    await page.evaluate(() => { app.move(90); for (let i = 0; i < 60; i++) app.stats.renderStats(); });
    // Repeating an accepted SSE packet must not invalidate full cached history.
    for (const stream of streams) stream.write(stateEvent());
    await page.waitForFunction(() => app.states === 3);
    assert.equal(await page.locator('[data-stat-key="progress"]').textContent(), '90%');
    assert.equal(requests.length, 2);
    assert.equal(await page.locator('video').count(), 1);
    assert.deepEqual(external, []);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ engine, mode, requests, connections, events,
      cachedProgress: '90%', pageErrors: errors, externalRequests: external }));
  } finally {
    held?.destroy();
    await page.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

for (const [engine, launcher] of Object.entries({ chromium, webkit })) {
  const browser = await launcher.launch({ headless: true, args: engine === 'chromium' ? ['--no-sandbox'] : [] });
  try {
    await scenario(browser, engine, 'receiver');
    await scenario(browser, engine, 'local-seek');
  } finally { await browser.close(); }
}
console.log('History reconnect: connected Stats/PlayerUpdates/Cast clock recovery, future/coalescing/cache/local-seek controls passed in both engines; WebKit Cast remains unavailable.');
