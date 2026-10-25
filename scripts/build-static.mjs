import { createHash } from 'node:crypto';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const app = process.argv[2];
if (!['web', 'site'].includes(app)) throw new Error('Choose web or site.');
const root = fileURLToPath(new URL('../', import.meta.url));
const source = path.join(root, 'apps', app, 'src');
const output = path.join(root, 'dist/apps', app);
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

if (app === 'site') {
  await cp(source, output, { recursive: true });
} else {
  const rootFiles = new Set(['index.html', 'manifest.webmanifest', 'service-worker.js']);
  await mkdir(path.join(output, 'static'), { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (rootFiles.has(entry.name)) continue;
    await cp(path.join(source, entry.name), path.join(output, 'static', entry.name), { recursive: true });
  }
  let html = await readFile(path.join(source, 'index.html'), 'utf8');
  // Source served by Python defaults to Python. Standalone hosting is an explicit
  // demo, so its first page load does not try a same-origin /api on a static host.
  html = html.replace(/(<meta\s+name="layerglass-backend"\s+content=")[^"]+("\s*\/?>)/,
    '$1demo$2');
  await writeFile(path.join(output, 'index.html'), html);
  await cp(path.join(source, 'manifest.webmanifest'), path.join(output, 'manifest.webmanifest'));

  const digest = createHash('sha256');
  const hashTree = async directory => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await hashTree(file);
      else if (!file.endsWith('.map')) digest.update(path.relative(output, file)).update('\0').update(await readFile(file));
    }
  };
  await hashTree(output);
  const revision = digest.digest('hex').slice(0, 24);
  const worker = (await readFile(path.join(source, 'service-worker.js'), 'utf8'))
    .replaceAll('__APP_SHELL_REVISION__', revision).replaceAll('__PWA_CACHE_ENABLED__', 'false');
  await writeFile(path.join(output, 'service-worker.js'), worker);
}
console.log(`Built native static assets → dist/apps/${app}`);
