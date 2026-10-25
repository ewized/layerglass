// Run with fixture VIEWER_ALLOWED_ORIGINS=http://localhost:8080 and
// VIEWER_BACKEND_ORIGINS=http://127.0.0.1:8080. Both names are loopback here.
import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { waitForPlayer } from './player-page.js';

const backend = process.env.VIEWER_URL || 'http://127.0.0.1:8080';
const frontend = backend.replace('127.0.0.1', 'localhost');
assert.notEqual(frontend, backend, 'This fixture uses two distinct loopback origins.');

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
    console.log(`${name}: selected backend handles CORS snapshot/SSE, session, continuous video, and protected POST`);
  } finally { await browser.close(); }
}
