import { readFileSync } from 'node:fs';
export { fixtureAddress, fixtureOrigin } from '../../../tests/http.ts';

// Keep generated HTTP fixtures aligned with the same explicit browser-module
// list used by the Python viewer and the static build. Only public source roots
// are eligible; paths cannot escape into project configuration or Python code.
const modules: string[] = JSON.parse(
  readFileSync(new URL('../browser-modules.json', import.meta.url), 'utf8'),
);
const roots: Array<[string, URL]> = [
  ['/static/', new URL('../../../dist/browser/apps/layerglass/src/', import.meta.url)],
  ...modules.map((name): [string, URL] => [
    `/${name}/src/`,
    new URL(`../../../dist/browser/apps/${name}/src/`, import.meta.url),
  ]),
];

export function fixtureAsset(pathname: string) {
  for (const [prefix, root] of roots) {
    if (!pathname.startsWith(prefix)) continue;
    const file = new URL(pathname.slice(prefix.length), root);
    return file.href.startsWith(root.href) ? file : null;
  }
  return null;
}
