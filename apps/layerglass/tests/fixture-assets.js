import { readFileSync } from 'node:fs';

// Keep generated HTTP fixtures aligned with the same explicit browser-module
// list used by the Python viewer and the static build. Only public source roots
// are eligible; paths cannot escape into project configuration or Python code.
const modules = JSON.parse(readFileSync(new URL('../browser-modules.json', import.meta.url), 'utf8'));
const roots = [
  ['/static/', new URL('../src/', import.meta.url)],
  ...modules.map(name => [`/${name}/src/`, new URL(`../../${name}/src/`, import.meta.url)]),
];

export function fixtureAsset(pathname) {
  for (const [prefix, root] of roots) {
    if (!pathname.startsWith(prefix)) continue;
    const file = new URL(pathname.slice(prefix.length), root);
    return file.href.startsWith(root.href) ? file : null;
  }
  return null;
}
