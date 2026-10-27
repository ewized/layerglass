import type * as CastSenderTypes from '../src/cast-sender.js';
import type * as LogTypes from '../src/log.js';
import type * as PlayerMediaTypes from '../src/player-media.js';
import type * as PreferencesTypes from '../src/preferences.js';
import type * as RefreshTypes from '../src/refresh.js';
import type * as ReplayTypes from '../src/replay.js';
import type * as UpdatesTypes from '../src/updates.js';
import type * as VideoStreamTypes from '../src/video-stream.js';
import type * as VisibilityTypes from '../src/visibility.js';
import ts from 'typescript';
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';

interface BrowserModules {
  'cast-sender.js': typeof CastSenderTypes;
  'log.js': typeof LogTypes;
  'player-media.js': typeof PlayerMediaTypes;
  'preferences.js': typeof PreferencesTypes;
  'refresh.js': typeof RefreshTypes;
  'replay.js': typeof ReplayTypes;
  'updates.js': typeof UpdatesTypes;
  'video-stream.js': typeof VideoStreamTypes;
  'visibility.js': typeof VisibilityTypes;
}

function browserSource(identifier: string) {
  const url = new URL(identifier);
  if (existsSync(url)) return readFileSync(url, 'utf8');
  const source = new URL(url.href.replace(/\.js$/, '.ts'));
  return ts.transpileModule(readFileSync(source, 'utf8'), {
    fileName: source.pathname,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      verbatimModuleSyntax: true,
    },
  }).outputText;
}

// Evaluate the actual browser ESM graph with isolated DOM/clock doubles.
// npm test enables Node's VM modules; production uses native browser imports.
export async function loadBrowserModule<Name extends keyof BrowserModules>(
  name: Name,
  context: vm.Context,
  mocks: Record<string, Record<string, unknown>> = {},
): Promise<BrowserModules[Name]> {
  const url = new URL(`../src/${name}`, import.meta.url);
  const replacements = new Map(
    Object.entries(mocks).map(([specifier, value]) => [new URL(specifier, url).href, value]),
  );
  const modules = new Map<string, vm.Module>();
  const getModule = (identifier: string): vm.Module => {
    const cached = modules.get(identifier);
    if (cached) return cached;
    const mock = replacements.get(identifier);
    const module = mock
      ? new vm.SyntheticModule(
          Object.keys(mock),
          function () {
            for (const [name, value] of Object.entries(mock)) this.setExport(name, value);
          },
          { context, identifier },
        )
      : new vm.SourceTextModule(browserSource(identifier), {
          context,
          identifier,
          initializeImportMeta(meta) {
            meta.url = identifier;
          },
        });
    modules.set(identifier, module);
    return module;
  };
  const entry = getModule(url.href);
  await entry.link((specifier, module) => getModule(new URL(specifier, module.identifier).href));
  await entry.evaluate();
  // The module name selects the production source and its exact export contract.
  return entry.namespace as BrowserModules[Name];
}
