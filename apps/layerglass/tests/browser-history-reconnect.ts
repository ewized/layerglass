import { fixtureAddress } from '../../../tests/http.ts';
import type { Browser, Route } from 'playwright';
import type { ServerResponse } from 'node:http';
import { fixtureModule } from './fixture-module.ts';
const fixtureScript = await fixtureModule('history-reconnect');
import { fixtureAsset } from './fixture-assets.ts';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import { chromium, webkit } from 'playwright';

const fixture = JSON.parse(
  await fs.readFile(new URL('./fixtures/history-reconnect.json', import.meta.url), 'utf8'),
);

async function until(predicate: () => unknown) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert(Date.now() < deadline, 'The generated history request did not reach the fixture.');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function pageHTML(engine: string) {
  return `<!doctype html><html><head><link rel="stylesheet" href="/static/style.css"></head><body data-engine="${engine}">
<printer-player id="player" class="player" tabindex="0"></printer-player>
<script type="module">${fixtureScript}</script></body></html>`;
}

async function scenario(browser: Browser, engine: string, mode: string) {
  const requests: Array<{ at: number; phase: string }> = [],
    connections: Array<string> = [],
    streams = new Set<ServerResponse>();
  let phase = 'before',
    held: ServerResponse | null | undefined;
  const stateEvent = () => 'event: state\ndata: ' + JSON.stringify(fixture[phase]) + '\n\n';
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url!, 'http://fixture.invalid');
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
      else
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(fixture.partial));
      return;
    }
    if (url.pathname === '/__advance') {
      phase = 'after';
      for (const stream of streams) stream.end();
      streams.clear();
      response.writeHead(200).end('ok');
      return;
    }
    if (url.pathname === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html' }).end(pageHTML(engine));
      return;
    }
    const file = fixtureAsset(url.pathname);
    if (file) {
      try {
        const body = await fs.readFile(file);
        response
          .writeHead(200, { 'Content-Type': url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript' })
          .end(body);
      } catch {
        response.writeHead(404).end();
      }
      return;
    }
    // PageReplay releases its generated session on page exit.
    response.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + fixtureAddress(server).port;
  const page = await browser.newPage({ serviceWorkers: 'block' });
  const errors: Array<unknown> = [],
    external: Array<string> = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    // This fixture remains reachable on loopback in a network-none container.
    Object.defineProperty(navigator, 'onLine', { get: () => true });
  });
  await page.route('**/*', (route: Route) => {
    const url = new URL(route.request().url());
    if (url.origin === origin) return route.continue();
    external.push(url.href);
    return route.abort();
  });
  try {
    await page.goto(origin);
    await page.waitForFunction(() => window.ready && app.states === 1);
    assert.equal(await page.evaluate(() => app.castEligible), engine === 'chromium');
    await page.evaluate(() => {
      app.move(20);
      app.stats.show(true);
    });
    await page.waitForFunction(() => app.history.pending === null && app.history.peek(1220)?.progress === 20);
    assert.deepEqual(requests, [{ at: 1220, phase: 'before' }]);
    assert.equal(await page.locator('[data-stat-key="progress"]').textContent(), '20%');
    await page.evaluate(() => {
      // Negative model control: this point is not recorded yet, so repeated
      // reads must not request it. The receiver remains inside its real bounds.
      for (let i = 0; i < 60; i++) {
        app.history.read(1280);
        app.stats.renderStats();
      }
    });
    assert.equal(requests.length, 1);
    await page.evaluate(() => fetch('/__advance'));
    await page.waitForFunction(() => app.states === 2 && app.updates!.streaming);
    assert.deepEqual(connections, ['before', 'after']);
    if (mode === 'receiver') await page.evaluate(() => app.move(80));
    else
      await page.evaluate(() => {
        app.move(20);
        app.replay.seek(80);
      });
    // Let the real Stats timer initiate receiver recovery; do not synthesize a
    // local seek or call history.load/retry in the receiver scenario.
    await page.waitForFunction(() => app.history.pending === 10, undefined, { timeout: 5000 });
    await until(() => requests.length === 2);
    assert.deepEqual(requests, [
      { at: 1220, phase: 'before' },
      { at: 1280, phase: 'after' },
    ]);
    await page.evaluate(() => {
      for (let i = 0; i < 60; i++) app.stats.renderStats();
    });
    assert.equal(requests.length, 2, 'Pending hydration must coalesce all render reads.');
    assert(held);
    held.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(fixture.full));
    held = null;
    await page.waitForFunction(() => app.history.pending === null && app.history.peek(1280)?.progress === 80);
    assert.equal(await page.locator('[data-stat-key="progress"]').textContent(), '80%');
    const events = await page.evaluate(() => ({
      replay: app.replayEvents,
      native: app.nativeSeeks,
      unavailable: app.unavailable,
      remote: app.replay.remote === app.sender,
      position: app.replay.bounds().current,
    }));
    assert.deepEqual(events, {
      replay: mode === 'receiver' ? 0 : 1,
      native: 0,
      unavailable: 1,
      remote: true,
      position: 80,
    });
    await page.evaluate(() => {
      app.move(90);
      for (let i = 0; i < 60; i++) app.stats.renderStats();
    });
    // Repeating an accepted SSE packet must not invalidate full cached history.
    for (const stream of streams) stream.write(stateEvent());
    await page.waitForFunction(() => app.states === 3);
    assert.equal(await page.locator('[data-stat-key="progress"]').textContent(), '90%');
    assert.equal(requests.length, 2);
    assert.equal(await page.locator('video').count(), 1);
    assert.deepEqual(external, []);
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({
        engine,
        mode,
        requests,
        connections,
        events,
        cachedProgress: '90%',
        pageErrors: errors,
        externalRequests: external,
      }),
    );
  } finally {
    held?.destroy();
    await page.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

for (const [engine, launcher] of Object.entries({ chromium, webkit })) {
  const browser = await launcher.launch({
    headless: true,
    args: engine === 'chromium' ? ['--no-sandbox'] : [],
  });
  try {
    await scenario(browser, engine, 'receiver');
    await scenario(browser, engine, 'local-seek');
  } finally {
    await browser.close();
  }
}
console.log(
  'History reconnect: connected Stats/PlayerUpdates/Cast clock recovery, future/coalescing/cache/local-seek controls passed in both engines; WebKit Cast remains unavailable.',
);
