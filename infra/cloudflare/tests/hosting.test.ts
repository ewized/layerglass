import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { checkBuild, prepare, verify } from '../../../scripts/cloudflare.ts';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html =
  '<meta name="layerglass-backend" content="choose"><meta name="layerglass-renderer" content="edge"><printer-backend-picker data-ssr></printer-backend-picker>';

async function fixture(t: TestContext, name = 'layerglass') {
  const project = await mkdtemp(join(tmpdir(), 'layerglass-cloudflare-'));
  t.after(() => rm(project, { recursive: true, force: true }));
  const directory = join(project, 'dist/apps', name);
  await mkdir(join(project, 'dist/apps/.edge'), { recursive: true });
  await writeFile(join(project, 'dist/apps/.edge/layerglass.mjs'), 'export default {};');
  await mkdir(join(directory, 'static/backend'), { recursive: true });
  await mkdir(join(directory, 'demo-backend/src/demo'), { recursive: true });
  await mkdir(join(directory, 'local-backend/src'), { recursive: true });
  await mkdir(join(directory, 'static/components'), { recursive: true });
  await mkdir(join(project, 'infra/cloudflare'), { recursive: true });
  for (const suffix of ['wrangler.json', 'headers']) {
    await copyFile(join(source, `${name}.${suffix}`), join(project, 'infra/cloudflare', `${name}.${suffix}`));
  }
  await writeFile(join(directory, 'index.html'), name === 'layerglass' ? html : '<h1>LayerGlass</h1>');
  await writeFile(
    join(directory, 'service-worker.js'),
    "const revision = 'fixture';\nconst cacheEnabled = false;",
  );
  await writeFile(join(directory, 'static/backend/index.js'), 'export const backend = {};');
  await writeFile(join(directory, 'demo-backend/src/index.js'), '// demo provider');
  await writeFile(join(directory, 'local-backend/src/index.js'), '// local provider');
  await writeFile(join(directory, 'static/bootstrap.js'), '// fixture');
  await writeFile(join(directory, 'static/components/backend-picker.js'), '// fixture');
  await writeFile(join(directory, 'demo-backend/src/demo/printer.mp4'), 'fixture');
  return { project, directory };
}

test('prepare publishes only matching hosting headers into each built output', async (t) => {
  for (const name of ['layerglass-site', 'layerglass']) {
    const { project, directory } = await fixture(t, name);
    await prepare(name, project);
    assert.equal(
      await readFile(join(directory, '_headers'), 'utf8'),
      await readFile(join(source, `${name}.headers`), 'utf8'),
    );
  }
});

test('hosted app refuses an automatic Python or demo backend before deployment', async (t) => {
  const { project, directory } = await fixture(t);
  for (const type of ['python', 'demo']) {
    await writeFile(join(directory, 'index.html'), html.replace('choose', type));
    await assert.rejects(checkBuild('layerglass', project), /must require a backend choice/);
  }
});

test('hosted development app refuses enabled or unexpanded shell caching', async (t) => {
  const { project, directory } = await fixture(t);
  for (const text of ['const cacheEnabled = true;', 'const cacheEnabled = __PWA_CACHE_ENABLED__;']) {
    await writeFile(join(directory, 'service-worker.js'), text);
    await assert.rejects(checkBuild('layerglass', project), /shell caching disabled/);
  }
});

test('app cannot be published without its bundled browser provider and demo video', async (t) => {
  const { project, directory } = await fixture(t);
  await rm(join(directory, 'demo-backend/src/demo/printer.mp4'));
  await assert.rejects(checkBuild('layerglass', project), /ENOENT/);
});

test('deployment scope rejects an extra domain and accidental private root files', async (t) => {
  const { project, directory } = await fixture(t);
  await writeFile(join(directory, '.env'), 'fixture=value');
  await assert.rejects(checkBuild('layerglass', project), /private\/backend/);
  await rm(join(directory, '.env'));
  const configFile = join(project, 'infra/cloudflare/layerglass.wrangler.json');
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  config.routes.push({ pattern: 'unrelated.example', custom_domain: true });
  await writeFile(configFile, JSON.stringify(config));
  await assert.rejects(checkBuild('layerglass', project), /scope\/configuration/);
});

test('no SPA routing can turn nonexistent backend requests into HTML success', async (t) => {
  const { project } = await fixture(t);
  const configFile = join(project, 'infra/cloudflare/layerglass.wrangler.json');
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  config.assets.not_found_handling = 'single-page-application';
  await writeFile(configFile, JSON.stringify(config));
  await assert.rejects(checkBuild('layerglass', project), /scope\/configuration/);
});

function deployed({ apiStatus = 404, scriptType = 'application/javascript', cache = 'no-store' } = {}) {
  return async (url: URL) => {
    const path = new URL(url).pathname;
    const missing = [
      '/api/backend',
      '/_headers',
      '/.edge/layerglass.mjs',
      '/layerglass-missing-file',
    ].includes(path);
    const headers = {
      'content-security-policy': "default-src 'self'; frame-ancestors 'none'",
      'x-content-type-options': 'nosniff',
      'x-layerglass-renderer': 'edge',
      'cache-control': cache,
      'content-type': path.endsWith('.js') ? scriptType : 'text/html',
    };
    return new Response(path === '/' ? html : 'const cacheEnabled = false;', {
      status: missing ? apiStatus : 200,
      headers,
    });
  };
}

test('post-deployment checks accept the backend chooser and real 404 responses', async () => {
  await verify('layerglass', { fetchImpl: deployed() });
});

test('post-deployment checks detect a proxy or SPA returning HTML for APIs', async () => {
  await assert.rejects(verify('layerglass', { fetchImpl: deployed({ apiStatus: 200 }) }), /must return 404/);
});

test('post-deployment checks detect stale caching and incorrect JS MIME', async () => {
  await assert.rejects(
    verify('layerglass', { fetchImpl: deployed({ cache: 'max-age=3600' }) }),
    /caching unexpectedly/,
  );
  await assert.rejects(
    verify('layerglass', { fetchImpl: deployed({ scriptType: 'text/html' }) }),
    /MIME type/,
  );
});

test('web CSP permits chosen HTTPS backend media without remote executable code', async () => {
  const headers = await readFile(join(source, 'layerglass.headers'), 'utf8');
  assert.match(headers, /connect-src 'self' https:/);
  assert.match(headers, /media-src 'self' blob: https:/);
  assert.match(headers, /script-src 'self' https:\/\/www\.gstatic\.com chrome-extension:/);
  assert.doesNotMatch(headers, /unsafe-inline|unsafe-eval|script-src[^;]* https:;/);
  assert.doesNotMatch(headers, /remote-playback=\(\)|picture-in-picture=\(\)|fullscreen=\(\)/);
});
