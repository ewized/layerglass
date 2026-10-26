import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = path.join(root, 'apps/python-backend');
const output = path.join(root, 'dist/apps/python-backend');
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const entry of await readdir(source, { withFileTypes: true })) {
  if (
    (entry.isFile() && (entry.name.endsWith('.py') || entry.name === 'requirements.txt')) ||
    entry.name === 'providers'
  ) {
    await cp(path.join(source, entry.name), path.join(output, entry.name), {
      recursive: true,
      filter: (candidate) =>
        !candidate.split(path.sep).includes('__pycache__') && !candidate.endsWith('.pyc'),
    });
  }
}
console.log(
  'Packaged Python sources → dist/apps/python-backend (install Python requirements before running).',
);
