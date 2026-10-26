import { build } from 'esbuild';
import { renderAppShell } from '../infra/cloudflare/src/render-shell.ts';
import { createHash } from 'node:crypto';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { compileBrowser } from './compile-browser.ts';

const app = process.argv[2];
if (!['layerglass', 'layerglass-site'].includes(app || ''))
  throw new Error('Choose layerglass or layerglass-site.');
const root = fileURLToPath(new URL('../', import.meta.url));
const source = path.join(root, 'apps', app!, 'src');
const output = path.join(root, 'dist/apps', app!);
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

if (app === 'layerglass-site') {
  await cp(source, output, { recursive: true });
} else {
  const compiled = path.join(root, 'dist/browser/apps/layerglass/src');
  await rm(compiled, { recursive: true, force: true });
  await compileBrowser('layerglass', compiled);
  const rootFiles = new Set(['index.html', 'manifest.webmanifest', 'service-worker.js']);
  await mkdir(path.join(output, 'static'), { recursive: true });
  for (const entry of await readdir(compiled, { withFileTypes: true })) {
    if (rootFiles.has(entry.name)) continue;
    await cp(path.join(compiled, entry.name), path.join(output, 'static', entry.name), { recursive: true });
  }
  const modules = JSON.parse(await readFile(path.join(root, 'apps/layerglass/browser-modules.json'), 'utf8'));
  for (const name of modules) {
    await cp(path.join(root, 'dist/backends', name), path.join(output, name), { recursive: true });
  }
  let html = await readFile(path.join(compiled, 'index.html'), 'utf8');
  // Source served by Python knows its own backend. Standalone hosting requires
  // a choice, so a first visit never probes a backend or starts the demo silently.
  html = html.replace(/(<meta\s+name="layerglass-backend"\s+content=")[^"]+("\s*\/?>)/, '$1choose$2');
  await writeFile(path.join(output, 'index.html'), renderAppShell(html, 'static'));
  await build({
    entryPoints: [path.join(root, 'infra/cloudflare/src/worker.ts')],
    outfile: path.join(root, 'dist/apps/.edge/layerglass.mjs'),
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    minify: true,
  });
  await cp(path.join(source, 'manifest.webmanifest'), path.join(output, 'manifest.webmanifest'));

  const digest = createHash('sha256');
  const hashTree = async (directory: string): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name, 'en'),
    )) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await hashTree(file);
      else if (!file.endsWith('.map'))
        digest
          .update(path.relative(output, file))
          .update('\0')
          .update(await readFile(file));
    }
  };
  await hashTree(output);
  const revision = digest.digest('hex').slice(0, 24);
  const worker = (await readFile(path.join(compiled, 'service-worker.js'), 'utf8'))
    .replaceAll('__APP_SHELL_REVISION__', revision)
    .replaceAll('__PWA_CACHE_ENABLED__', 'false');
  await writeFile(path.join(output, 'service-worker.js'), worker);
}
console.log(`Built native static assets → dist/apps/${app}`);
