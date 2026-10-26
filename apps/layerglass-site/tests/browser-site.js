import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';

const root = new URL('../../../', import.meta.url);
const screenshots = resolve(process.env.LAYERGLASS_SITE_TEST_RESULTS || fileURLToPath(new URL('test-results/', root)));
await mkdir(screenshots, { recursive: true });
const server = spawn(process.execPath, ['scripts/serve-static.mjs', 'layerglass-site', '8102'], { cwd: root, stdio: 'pipe' });
const playerServer = spawn(process.execPath, ['scripts/serve-static.mjs', 'layerglass', '8101'], { cwd: root, stdio: 'pipe' });
let output = '';
playerServer.stderr.on('data', chunk => { output += chunk; });
server.stderr.on('data', chunk => { output += chunk; });
const base = 'http://127.0.0.1:8102';

try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await fetch(base)).ok) { ready = true; break; }
    } catch {}
    if (server.exitCode !== null) throw new Error(`Static preview exited: ${output}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert(ready, `Static preview failed to start: ${output}`);
  const range = await fetch(`${base}/mark.svg`, { headers: { Range: 'bytes=0-15' } });
  assert.equal(range.status, 206);
  assert.equal((await range.arrayBuffer()).byteLength, 16);
  assert.equal(range.headers.get('cache-control'), 'no-store');

  const worker = await readFile(new URL('dist/apps/layerglass/service-worker.js', root), 'utf8');
  assert(!worker.includes('__APP_SHELL_REVISION__'));
  assert(!worker.includes('__PWA_CACHE_ENABLED__'));
  assert(worker.includes('const cacheEnabled = false;'));

  for (const [name, engine] of Object.entries({ chromium, webkit })) {
    const browser = await engine.launch({ headless: true });
    try {
      for (const viewport of [
        { width: 1440, height: 1000 },
        { width: 414, height: 896 },
        { width: 390, height: 844 },
        { width: 320, height: 568 }
      ]) {
        const page = await browser.newPage({ viewport });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
        await page.goto(base, { waitUntil: 'networkidle' });
        assert.match(await page.title(), /LayerGlass/);
        assert.equal(await page.locator('h1').count(), 1);
        assert.equal(await page.locator('.actions .primary').getAttribute('href'), 'https://app.layer.glass/?backend=demo');
        const openApp = page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Open App', exact: true });
        assert.equal(await openApp.getAttribute('href'), 'https://app.layer.glass/');
        assert.equal(await openApp.isVisible(), true);
        const buttonBounds = await openApp.boundingBox();
        const brandBounds = await page.locator('header .brand').boundingBox();
        assert(buttonBounds.height >= 44, 'Open App remains a touch-sized header link.');
        assert(buttonBounds.x >= brandBounds.x + brandBounds.width,
          `${name} ${viewport.width}: Open App must not overlap the brand.`);
        assert.equal(await page.locator('script').count(), 0, 'The product site does not need a browser runtime.');
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true,
          `${name} ${viewport.width}: product site must fit the viewport.`);
        assert.equal(await page.locator('.brand img').evaluate(image => image.complete && image.naturalWidth > 0), true);
        assert.deepEqual(errors, []);
        if (name === 'chromium') await page.screenshot({ path: join(screenshots, `site-${viewport.width}.png`), fullPage: true });
        await page.route('https://app.layer.glass/**', route => route.fulfill({ contentType: 'text/html', body: '<title>App destination</title>' }));
        await openApp.click();
        await page.waitForURL('https://app.layer.glass/');
        await page.close();
      }
      const player = await browser.newPage({ viewport: { width: 390, height: 844 } });
      const playerErrors = [], backendRequests = [];
      player.on('pageerror', error => playerErrors.push(error.message));
      player.on('request', request => {
        if (/\/(?:api|replay)\//.test(new URL(request.url()).pathname)) backendRequests.push(request.url());
      });
      player.on('response', response => {
        if (response.status() >= 400) playerErrors.push(`${response.status()} ${response.url()}`);
      });
      await player.goto('http://127.0.0.1:8101/?backend=demo');
      assert.equal(await player.locator('meta[name="layerglass-backend"]').getAttribute('content'), 'choose');
      await player.waitForFunction(() => {
        const video = document.querySelector('video');
        return video?.readyState >= 2 && video.videoWidth > 0;
      });
      assert.equal(await player.evaluate(async () => (await import('/static/backend/index.js')).backend.id), 'demo');
      for (const module of ['/demo-backend/src/index.js', '/local-backend/src/index.js']) {
        const response = await player.request.get(`http://127.0.0.1:8101${module}`);
        assert.equal(response.status(), 200);
        assert.match(response.headers()['content-type'], /javascript/);
      }
      assert.deepEqual(playerErrors, [], 'The composed static player loads every native provider module.');
      assert.deepEqual(backendRequests, [], 'The hosted demo needs no Python API.');
      await player.close();
      console.log(`${name}: website desktop/mobile layout and composed static player/demo passed.`);
    } finally {
      await browser.close();
    }
  }
} finally {
  server.kill('SIGTERM');
  playerServer.kill('SIGTERM');
}
