import { mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { compileBrowser, browserProjects, type BrowserProject } from './compile-browser.ts';

const name = process.argv[2];
if (!browserProjects.some((project) => project !== 'layerglass' && project === name))
  throw new Error('Choose a browser backend project.');
const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'dist/backends', name!);
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await compileBrowser(name as BrowserProject, path.join(output, 'src'));
console.info(`Built native browser backend → dist/backends/${name}`);
