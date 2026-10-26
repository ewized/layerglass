import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const name = process.argv[2];
if (!['demo-backend', 'local-backend'].includes(name)) throw new Error('Choose a browser backend project.');
const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'dist/backends', name);
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(path.join(root, 'apps', name, 'src'), path.join(output, 'src'), { recursive: true });
console.info(`Built native browser backend → dist/backends/${name}`);
