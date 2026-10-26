// Run with fixture VIEWER_ALLOWED_ORIGINS=http://localhost:8080 and
// VIEWER_BACKEND_ORIGINS=http://127.0.0.1:8080. Both names are loopback here.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import { waitForPlayer } from './player-page.js';

const backend = process.env.VIEWER_URL || 'http://127.0.0.1:8080';
const frontend = backend.replace('127.0.0.1', 'localhost');
assert.notEqual(frontend, backend, 'This fixture uses two distinct loopback origins.');

async function rejectRedirectedSetup(browser) {
  const servers = [];
  const received = [];
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Viewer-Request', Connection: 'close' };
  const listen = async handler => {
    const server = createServer(handler);
    servers.push(server);
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    return `http://127.0.0.1:${server.address().port}`;
  };
  let context;
  try {
    const receiver = await listen(async (request, response) => {
      if (request.method === 'OPTIONS') { response.writeHead(204, cors).end(); return; }
      let body = '';
      for await (const chunk of request) body += chunk;
      received.push({ method: request.method, body });
      response.writeHead(200, { ...cors, 'Content-Type': 'application/json' }).end('{}');
    });
    const selected = await listen((request, response) => {
      request.resume();
      if (request.method === 'OPTIONS') { response.writeHead(204, cors).end(); return; }
      const status = Number(request.url.split('/').at(-1));
      response.writeHead(status, { ...cors, Location: `${receiver}/unselected/configure` }).end();
    });
    const source = await readFile(new URL('../src/backend/python.js', import.meta.url));
    // Deliberately no CSP: the selected-origin guarantee must come from the
    // backend fetch policy, even when another origin admits the redirected POST.
    const origin = await listen((request, response) => {
      response.writeHead(200, { 'Content-Type': request.url === '/backend-python.js' ?
        'text/javascript' : 'text/html', Connection: 'close' });
      response.end(request.url === '/backend-python.js' ? source : '<!doctype html><title>Redirect fixture</title>');
    });
    context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    await page.goto(origin);
    const results = await page.evaluate(async selected => {
      const { PythonBackend } = await import('/backend-python.js');
      const client = new PythonBackend(selected);
      const results = [];
      for (const status of [307, 308]) {
        try {
          await client.fetch(`/redirect/${status}`, { method: 'POST', redirect: 'follow', headers: {
            'Content-Type': 'application/json', 'X-Viewer-Request': '1',
          }, body: JSON.stringify({ access_code: 'synthetic-redirect-code' }) });
          results.push({ status, rejected: false });
        } catch (error) { results.push({ status, rejected: error instanceof TypeError }); }
      }
      return results;
    }, selected);
    assert.deepEqual(results, [{ status: 307, rejected: true }, { status: 308, rejected: true }]);
    assert.deepEqual(received, [], 'An unselected origin must receive no setup body, even if it permits CORS.');
  } finally {
    await context?.close();
    await Promise.all(servers.map(server => new Promise(resolve => {
      server.closeAllConnections();
      server.close(resolve);
    })));
  }
}

for (const [name, engine] of Object.entries({ chromium, webkit })) {
  if (process.env.BROWSER && process.env.BROWSER !== name) continue;
  const browser = await engine.launch({ headless: true });
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.addCookies([{ name: 'fixture-cross-origin-session', value: 'must-be-omitted', url: backend, httpOnly: true }]);
    await context.addInitScript(origin => localStorage.setItem('layerglass-backend', JSON.stringify({ type: 'python', url: origin })), backend);
    const page = await context.newPage();
    const errors = []; const requests = []; const backendHeaders = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      const url = new URL(request.url());
      requests.push(url);
      if (url.origin === backend && url.pathname.startsWith('/api/')) backendHeaders.push(request.allHeaders());
    });
    await page.goto(frontend);
    await waitForPlayer(page, ({ app }) => app.videoStream?.connected && app.video.currentTime > 1 &&
      app.pageReplay.session?.ready && document.querySelector('#overlay').hidden, null, { timeout: 45000 });
    assert.equal(await page.evaluate(async () => (await import('/static/backend/index.js')).backend.origin), backend);
    assert.deepEqual(await page.locator('#video, #jpeg').evaluateAll(elements => elements.map(element => element.crossOrigin)),
      ['anonymous', 'anonymous']);
    const session = await page.evaluate(async () => (await import('/static/player.js')).pageReplay.session);
    for (const field of ['playlist_url', 'video_url']) assert.equal(new URL(session[field]).origin, backend);
    const calls = requests.filter(url => url.pathname.startsWith('/api/') || url.pathname.startsWith('/replay/'));
    assert(calls.length > 1);
    assert(calls.every(url => url.origin === backend), 'All state/media APIs must use the selected backend, including SSE and session creation.');
    const result = await page.evaluate(async () => {
      const { backend } = await import('/static/backend/index.js');
      const description = await (await backend.fetch('/api/backend')).json();
      const scan = await backend.fetch('/api/discover', { method: 'POST', headers: {
        'Content-Type': 'application/json', 'X-Viewer-Request': '1',
      }, body: '{}' });
      return { description, scan: scan.status };
    });
    assert.equal(result.description.id, 'python');
    assert.equal(result.scan, 202);
    assert((await Promise.all(backendHeaders)).every(headers => !headers.cookie), 'Cross-origin state and commands omit cookies.');
    assert.deepEqual(errors, []);
    await context.close();
    await rejectRedirectedSetup(browser);
    console.log(`${name}: selected backend CORS/SSE/media and protected POST passed; 307/308 setup redirects rejected without forwarding a body`);
  } finally { await browser.close(); }
}
