import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

/** Emit checked fixture TypeScript for the generated browser, without a dev server. */
export async function fixtureModule(name: string, format: 'esm' | 'iife' = 'esm'): Promise<string> {
  if (!/^[a-z-]+$/.test(name)) throw new Error('Invalid browser fixture name');
  const result = await build({
    entryPoints: [fileURLToPath(new URL(`./fixtures/${name}.ts`, import.meta.url))],
    bundle: true,
    write: false,
    format,
    platform: 'browser',
    target: 'es2022',
    external: ['/static/*'],
  });
  const output = result.outputFiles[0];
  if (!output) throw new Error(`Empty browser fixture: ${name}`);
  return output.text;
}
