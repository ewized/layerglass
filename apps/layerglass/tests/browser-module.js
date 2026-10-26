import ts from 'typescript';
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';

function browserSource(identifier) {
  const url = new URL(identifier);
  if (existsSync(url)) return readFileSync(url, 'utf8');
  const source = new URL(url.href.replace(/\.js$/, '.ts'));
  return ts.transpileModule(readFileSync(source, 'utf8'), {
    fileName: source.pathname,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, verbatimModuleSyntax: true },
  }).outputText;
}

// Evaluate the actual browser ESM graph with isolated DOM/clock doubles.
// npm test enables Node's VM modules; production uses native browser imports.
export async function loadBrowserModule(name, context, mocks = {}) {
  const url = new URL(`../src/${name}`, import.meta.url);
  const replacements = new Map(Object.entries(mocks).map(([specifier, value]) =>
    [new URL(specifier, url).href, value]));
  const modules = new Map();
  const getModule = identifier => {
    if (modules.has(identifier)) return modules.get(identifier);
    const mock = replacements.get(identifier);
    const module = mock ? new vm.SyntheticModule(Object.keys(mock), function() {
      for (const [name, value] of Object.entries(mock)) this.setExport(name, value);
    }, { context, identifier }) : new vm.SourceTextModule(browserSource(identifier), {
      context, identifier, initializeImportMeta(meta) { meta.url = identifier; },
    });
    modules.set(identifier, module);
    return module;
  };
  const entry = getModule(url.href);
  await entry.link((specifier, module) => getModule(new URL(specifier, module.identifier).href));
  await entry.evaluate();
  return entry.namespace;
}
