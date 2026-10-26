import { mkdir, readdir, readFile, writeFile, cp } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { build } from 'esbuild';
import createEmotion from '@emotion/css/create-instance';
import { playerTheme } from '../apps/layerglass/src/theme.ts';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const browserProjects = ['backend-contracts', 'local-backend', 'demo-backend', 'layerglass'] as const;
export type BrowserProject = (typeof browserProjects)[number];

/** Preserve native ESM URLs; only third-party platform dependencies are bundled. */
export async function compileBrowser(name: BrowserProject, output: string) {
  const source = join(root, 'apps', name, 'src');
  await mkdir(output, { recursive: true });
  async function visit(directory: string, destination: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const from = join(directory, entry.name);
      const to = join(destination, entry.name);
      if (entry.isDirectory()) {
        await mkdir(to, { recursive: true });
        await visit(from, to);
      } else if (
        /\.d\.[cm]?ts$/.test(entry.name) ||
        entry.name === 'platform.ts' ||
        entry.name === 'service-worker.ts'
      )
        continue;
      else if (entry.name.endsWith('.ts')) {
        const result = ts.transpileModule(await readFile(from, 'utf8'), {
          fileName: from,
          compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.ESNext,
            verbatimModuleSyntax: true,
            sourceMap: true,
            inlineSources: true,
          },
        });
        await writeFile(to.replace(/\.ts$/, '.js'), result.outputText);
        if (result.sourceMapText) await writeFile(to.replace(/\.ts$/, '.js.map'), result.sourceMapText);
      } else await cp(from, to);
    }
  }
  await visit(source, output);
  if (name === 'layerglass') {
    // Locked dependencies supply generated JavaScript; authored source stays TypeScript.
    for (const name of ['hls.min.mjs', 'hls.min.mjs.map', 'hls.worker.js', 'hls.worker.js.map']) {
      await cp(join(root, 'node_modules/hls.js/dist', name), join(output, 'vendor', name));
    }
    const platform = await build({
      metafile: true,
      entryPoints: [join(source, 'platform.ts')],
      outfile: join(output, 'platform.js'),
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      minify: true,
    });
    const licenses = new Map<string, Set<string>>();
    const packages = new Set<string>();
    for (const input of Object.keys(platform.metafile.inputs)) {
      if (!input.includes('node_modules/')) continue;
      let directory = dirname(resolve(root, input));
      while (directory.includes('node_modules')) {
        try {
          const metadata: unknown = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
          if (
            metadata &&
            typeof metadata === 'object' &&
            'name' in metadata &&
            typeof metadata.name === 'string' &&
            'version' in metadata &&
            typeof metadata.version === 'string'
          ) {
            if (!packages.has(directory)) {
              let license = '';
              for (const name of ['LICENSE', 'LICENSE.md', 'LICENSE.txt']) {
                try {
                  license = await readFile(join(directory, name), 'utf8');
                  break;
                } catch {
                  /* Try the next package license name. */
                }
              }
              if (!license) throw new Error(`Missing bundled license: ${metadata.name}`);
              const names = licenses.get(license) || new Set<string>();
              names.add(`${metadata.name}@${metadata.version}`);
              licenses.set(license, names);
              packages.add(directory);
            }
            break;
          }
        } catch (error) {
          if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
        }
        directory = dirname(directory);
      }
    }
    await writeFile(
      join(output, 'platform.LICENSE.txt'),
      [...licenses]
        .map(([license, names]) => `${[...names].sort().join(', ')}\n${license.trim()}\n`)
        .join('\n'),
    );
    const emotion = createEmotion({ key: 'layerglass' });
    emotion.injectGlobal(playerTheme);
    const css = Object.values(emotion.cache.inserted)
      .filter((value): value is string => typeof value === 'string')
      .join('');
    await writeFile(join(output, 'style.css'), css);
    const html = (await readFile(join(source, 'index.html'), 'utf8')).replace(
      '</head>',
      `  <meta name="layerglass-emotion" content="${Object.keys(emotion.cache.inserted).join(' ')}">\n</head>`,
    );
    await writeFile(join(output, 'index.html'), html);
    await build({
      entryPoints: [join(source, 'service-worker.ts')],
      outfile: join(output, 'service-worker.js'),
      bundle: true,
      format: 'esm',
      target: 'es2022',
      banner: { js: 'export {};' },
    });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const name of browserProjects)
    await compileBrowser(name, join(root, 'dist/browser/apps', name, 'src'));
}
