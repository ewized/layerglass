import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const generated = new Set(['node_modules', 'dist', '.git', '.nx', 'test-results']);

/** Check the copied CI workspace too, where a Git index may not be available. */
export async function checkTypeScriptOnly(root: string): Promise<void> {
  const unexpected: string[] = [];
  async function visit(directory: string, prefix = ''): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory() && !generated.has(entry.name)) {
        await visit(join(directory, entry.name), relative);
      } else if (entry.isFile() && /\.(?:[cm]?js|jsx)$/.test(entry.name)) {
        unexpected.push(relative);
      }
    }
  }
  await visit(root);
  if (unexpected.length) {
    throw new Error(`Authored JavaScript is not allowed; use TypeScript:\n${unexpected.sort().join('\n')}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await checkTypeScriptOnly(fileURLToPath(new URL('..', import.meta.url)));
}
