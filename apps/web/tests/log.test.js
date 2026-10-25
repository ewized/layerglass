import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { loadBrowserModule } from './browser-module.js';

async function logger() {
  const entries = [];
  const context = vm.createContext({ console: Object.fromEntries(['info', 'warn', 'debug', 'error'].map(level =>
    [level, (...args) => entries.push({ level, args })])) });
  const { PlayerLog } = await loadBrowserModule('log.js', context);
  return { log: PlayerLog, entries };
}

test('scan progress produces only one start and one finish log per search', async () => {
  const { log, entries } = await logger();
  log.discovery({ state: 'done', checked: 100, total: 100 }); // Cached results on load.
  assert.equal(entries.length, 0);
  for (let checked = 0; checked <= 100; checked++) log.discovery({ state: 'scanning', checked, total: 100 });
  for (let repeat = 0; repeat < 10; repeat++) log.discovery({ state: 'done', checked: 100, total: 100 });
  assert.equal(entries.length, 2);
  assert.equal(entries[0].args[0], '[LayerGlass] Printer scan started');
  assert.equal(entries[1].args[0], '[LayerGlass] Printer scan finished');
  assert.equal(JSON.stringify(entries).includes('%'), false);
  log.discovery({ state: 'scanning' });
  log.discovery({ state: 'error' });
  log.discovery({ state: 'error' });
  assert.equal(entries.length, 4);
  assert.equal(entries[3].level, 'warn');
});

test('a scan ID prevents delayed responses and stale progress from duplicating logs', async () => {
  const { log, entries } = await logger();
  log.discovery({ state: 'done', scan_id: 'previous' });
  log.discovery({ state: 'scanning', scan_id: 'next' });
  log.discovery({ state: 'done', scan_id: 'previous' });
  log.discovery({ state: 'done', scan_id: 'next' });
  log.discovery({ state: 'scanning', scan_id: 'next' }, true);
  log.discovery({ state: 'done', scan_id: 'next' }, true);
  assert.equal(entries.length, 2);
  log.discovery({ state: 'done', scan_id: 'instant' }, true);
  log.discovery({ state: 'done', scan_id: 'instant' });
  assert.equal(entries.length, 4, 'Even a scan completed before its response has just two messages.');
});
