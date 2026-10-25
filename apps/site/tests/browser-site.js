import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';

const root = new URL('../../../', import.meta.url);
const server = spawn(process.execPath, ['scripts/serve-static.mjs', 'site', '8102'], { cwd: root, stdio: 'pipe' });
let output = '';
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

  const worker = await readFile(new URL('dist/apps/web/service-worker.js', root), 'utf8');
  assert(!worker.includes('__APP_SHELL_REVISION__'));
  assert(!worker.includes('__PWA_CACHE_ENABLED__'));
  assert(worker.includes('const cacheEnabled = false;'));

  for (const [name, engine] of Object.entries({ chromium, webkit })) {
    const browser = await engine.launch({ headless: true });
    try {
      for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
        const page = await browser.newPage({ viewport });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
        await page.goto(base, { waitUntil: 'networkidle' });
        assert.match(await page.title(), /LayerGlass/);
        assert.equal(await page.locator('h1').count(), 1);
        assert.equal(await page.locator('.actions .primary').getAttribute('href'), 'https://app.layer.glass/?backend=demo');
        assert.equal(await page.locator('script').count(), 0, 'The product site does not need a browser runtime.');
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true,
          `${name} ${viewport.width}: product site must fit the viewport.`);
        assert.equal(await page.locator('.brand img').evaluate(image => image.complete && image.naturalWidth > 0), true);
        assert.deepEqual(errors, []);
        if (name === 'chromium') await page.screenshot({ path: `/app/test-results/site-${viewport.width}.png`, fullPage: true });
        await page.close();
      }
      console.log(`${name}: product website desktop/mobile layout, navigation and assets passed.`);
    } finally {
      await browser.close();
    }
  }
} finally {
  server.kill('SIGTERM');
}
