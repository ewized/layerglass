import { access, copyFile, readFile, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const targets = Object.freeze({
  'layerglass-site': { name: 'layerglass-site', domain: 'layer.glass' },
  layerglass: { name: 'layerglass-web', domain: 'app.layer.glass' },
});

function target(name) {
  if (!Object.hasOwn(targets, name)) throw new Error(`Unknown Cloudflare target: ${name}`);
  return targets[name];
}

export async function checkBuild(name, project = root) {
  const expected = target(name);
  const configPath = join(project, 'infra/cloudflare', `${name}.wrangler.json`);
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  if (config.name !== expected.name || config.routes?.length !== 1 ||
      config.routes[0].pattern !== expected.domain || config.routes[0].custom_domain !== true ||
      config.workers_dev !== false || config.preview_urls !== false ||
      config.assets?.not_found_handling !== 'none' || config.main ||
      config.assets?.directory !== `../../dist/apps/${name}`) {
    throw new Error(`Unexpected Cloudflare scope/configuration for ${name}`);
  }
  const directory = join(project, 'dist/apps', name);
  const html = await readFile(join(directory, 'index.html'), 'utf8');
  const entries = await readdir(directory);
  // Deployment output is public. Refuse accidental private configuration at its root.
  if (entries.some(entry => entry === '.env' || entry.startsWith('.env.') ||
      ['data', 'recordings', 'buffer', 'app.py', 'cameras.py'].includes(entry))) {
    throw new Error(`Unexpected private/backend file in ${name} output`);
  }
  if (name === 'layerglass') {
    if (!/<meta\s+name="layerglass-backend"\s+content="choose"\s*\/?\s*>/.test(html)) {
      throw new Error('Hosted web build must require a backend choice');
    }
    const worker = await readFile(join(directory, 'service-worker.js'), 'utf8');
    if (/__APP_SHELL_REVISION__|__PWA_CACHE_ENABLED__/.test(worker) ||
        !/const\s+cacheEnabled\s*=\s*false\s*;/.test(worker)) {
      throw new Error('Hosted development service worker must have shell caching disabled');
    }
    await access(join(directory, 'static/backend/index.js'));
    await access(join(directory, 'static/bootstrap.js'));
    await access(join(directory, 'static/components/backend-picker.js'));
    await access(join(directory, 'demo-backend/src/index.js'));
    await access(join(directory, 'local-backend/src/index.js'));
    await access(join(directory, 'demo-backend/src/demo/printer.mp4'));
  }
  return { configPath, directory };
}

export async function prepare(name, project = root) {
  const result = await checkBuild(name, project);
  await copyFile(join(project, 'infra/cloudflare', `${name}.headers`), join(result.directory, '_headers'));
  return result;
}

export async function verify(name, { fetchImpl = fetch, origin } = {}) {
  const selected = target(name);
  const base = origin || `https://${selected.domain}`;
  const paths = name === 'layerglass' ? ['/', '/static/bootstrap.js', '/static/player.js', '/service-worker.js', '/manifest.webmanifest',
    '/demo-backend/src/index.js', '/local-backend/src/index.js'] : ['/'];
  for (const path of paths) {
    const response = await fetchImpl(new URL(path, base), { redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`${selected.domain}${path} returned ${response.status}`);
    const policy = response.headers.get('content-security-policy') || '';
    if (!policy.includes("frame-ancestors 'none'") || response.headers.get('x-content-type-options') !== 'nosniff') {
      throw new Error(`Security headers missing on ${selected.domain}${path}`);
    }
    if (name === 'layerglass' && response.headers.get('cache-control') !== 'no-store') {
      throw new Error(`Hosted app caching unexpectedly enabled on ${path}`);
    }
    if (path === '/') {
      const html = await response.text();
      if (name === 'layerglass' && !/<meta\s+name="layerglass-backend"\s+content="choose"/.test(html)) {
        throw new Error('Deployed app does not require a backend choice');
      }
    } else if (path.endsWith('.js')) {
      if (!/javascript/.test(response.headers.get('content-type') || '')) {
        throw new Error(`Incorrect module MIME type on ${path}`);
      }
      const script = await response.text();
      if (path === '/service-worker.js' && !/const\s+cacheEnabled\s*=\s*false\s*;/.test(script)) {
        throw new Error('Deployed service worker has enabled shell caching');
      }
    } else {
      await response.arrayBuffer();
    }
  }
  // No SPA rewrite: nonexistent APIs must not look like successful backend calls.
  for (const path of ['/api/backend', '/_headers', '/layerglass-missing-file']) {
    const response = await fetchImpl(new URL(path, base), { redirect: 'error', signal: AbortSignal.timeout(15000) });
    await response.arrayBuffer();
    if (response.status !== 404) throw new Error(`${selected.domain}${path} must return 404, got ${response.status}`);
  }
}

async function wrangler(action, name) {
  const { configPath } = await checkBuild(name);
  const binary = join(root, 'infra/cloudflare/node_modules/.bin/wrangler');
  await access(binary, constants.X_OK);
  if (action === 'deploy' && (!process.env.CLOUDFLARE_API_TOKEN || !process.env.CLOUDFLARE_ACCOUNT_ID)) {
    throw new Error('Deployment needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in the environment');
  }
  const args = ['deploy', '--config', configPath];
  if (action === 'dry-run') args.push('--dry-run');
  await new Promise((done, fail) => {
    const child = spawn(binary, args, {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false',
        XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME || join(tmpdir(), 'layerglass-cloudflare-config') },
    });
    child.on('error', fail);
    child.on('exit', code => code === 0 ? done() : fail(new Error(`Wrangler ${action} ${name} failed (${code})`)));
  });
}

export async function main(args = process.argv.slice(2)) {
  const [action = 'check', selection = 'all'] = args;
  if (args.length > 2 || !['prepare', 'check', 'dry-run', 'deploy', 'verify'].includes(action)) {
    throw new Error('Usage: node scripts/cloudflare.mjs [prepare|check|dry-run|deploy|verify] [layerglass-site|layerglass|all]');
  }
  const names = selection === 'all' ? Object.keys(targets) : [selection];
  for (const name of names) {
    target(name);
    if (action === 'verify') await verify(name);
    else if (action === 'check') {
      const { directory } = await checkBuild(name);
      const headers = await readFile(join(directory, '_headers'), 'utf8');
      const source = await readFile(join(root, 'infra/cloudflare', `${name}.headers`), 'utf8');
      if (headers !== source) throw new Error(`Run Cloudflare prepare for ${name} after building`);
    } else {
      await prepare(name);
      if (action !== 'prepare') await wrangler(action, name);
    }
    console.info(`Cloudflare ${action}: ${name} complete`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
