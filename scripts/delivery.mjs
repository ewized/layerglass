import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { targets } from './cloudflare.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const manifestName = 'deployment.json';

function revision(value) {
  if (!/^[a-f0-9]{40}$/.test(value || '')) throw new Error('Delivery requires a full Git commit SHA');
  return value;
}

async function assets(project) {
  const directory = join(project, 'dist/apps'), files = [];
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.some(entry => !['site', 'web', manifestName].includes(entry.name) ||
        entry.name === manifestName && !entry.isFile()) ||
      !['site', 'web'].every(name => entries.some(entry => entry.name === name && entry.isDirectory()))) {
    throw new Error('Delivery output must contain only the site and web builds');
  }
  async function walk(relative) {
    for (const entry of await readdir(join(directory, relative), { withFileTypes: true })) {
      const path = `${relative}/${entry.name}`;
      if (entry.isSymbolicLink() || entry.name === '.git' || entry.name === '.env' || entry.name.startsWith('.env.')) {
        throw new Error(`Unexpected private file or symbolic link in delivery: ${path}`);
      }
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        const bytes = await readFile(join(directory, path));
        files.push({ path, sha256: digest(bytes), size: bytes.length });
      } else throw new Error(`Unsupported delivery entry: ${path}`);
    }
  }
  for (const name of ['site', 'web']) await walk(name);
  if (!['site/index.html', 'web/index.html'].every(path => files.some(file => file.path === path))) {
    throw new Error('Delivery needs both application entrypoints');
  }
  return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

export async function prepareDelivery(source, project = root) {
  const manifest = { schema: 1, source: revision(source), files: await assets(project) };
  await writeFile(join(project, 'dist/apps', manifestName), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

export async function verifyDelivery(source, project = root) {
  revision(source);
  const files = await assets(project);
  const manifest = JSON.parse(await readFile(join(project, 'dist/apps', manifestName), 'utf8'));
  if (manifest.schema !== 1 || manifest.source !== source ||
      !isDeepStrictEqual(Object.keys(manifest).sort(), ['files', 'schema', 'source']) ||
      !isDeepStrictEqual(manifest.files, files)) {
    throw new Error('Delivery artifact differs from its validated source or file manifest');
  }
  return manifest;
}

export async function verifyPublished(source, { project = root, fetchImpl = fetch } = {}) {
  const manifest = await verifyDelivery(source, project);
  const selected = { site: ['index.html'], web: ['index.html', 'static/bootstrap.js', 'service-worker.js'] };
  for (const [name, paths] of Object.entries(selected)) {
    for (const path of paths) {
      const expected = manifest.files.find(file => file.path === `${name}/${path}`);
      if (!expected) throw new Error(`Delivery artifact lacks ${name}/${path}`);
      const url = new URL(path === 'index.html' ? '/' : `/${path}`, `https://${targets[name].domain}`);
      const response = await fetchImpl(url, { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15000) });
      if (!response.ok || digest(Buffer.from(await response.arrayBuffer())) !== expected.sha256) {
        throw new Error(`Published bytes differ from the validated artifact: ${url}`);
      }
    }
  }
}

export async function main(args = process.argv.slice(2)) {
  const [action, source] = args;
  if (args.length !== 2 || !['prepare', 'verify', 'published'].includes(action)) {
    throw new Error('Usage: node scripts/delivery.mjs [prepare|verify|published] COMMIT_SHA');
  }
  if (action === 'prepare') await prepareDelivery(source);
  else if (action === 'verify') await verifyDelivery(source);
  else await verifyPublished(source);
  console.info(`Delivery ${action}: ${source}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
