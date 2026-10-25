import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { loadBrowserModule } from './browser-module.js';

async function preferences(values) {
  const storage = new Map(Object.entries(values));
  const localStorage = { getItem: key => storage.get(key) || null,
    setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
  const module = await loadBrowserModule('preferences.js', vm.createContext({ localStorage }));
  return { ...module, storage };
}

test('existing device camera selection migrates once to the generic storage key', async () => {
  const p = await preferences({ 'bambu-camera': 'existing-id', unrelated: 'retained' });
  assert.equal(p.readCamera(), 'existing-id');
  assert.equal(p.storage.get('printer-camera'), 'existing-id');
  assert.equal(p.storage.has('bambu-camera'), false);
  assert.equal(p.storage.get('unrelated'), 'retained');
});

test('the current selection wins over an older key and clearing cannot restore it', async () => {
  const p = await preferences({ 'bambu-camera': 'old-id', 'printer-camera': 'current-id' });
  assert.equal(p.readCamera(), 'current-id');
  p.writeCamera(null);
  assert.equal(p.readCamera(), null);
  assert.equal(p.storage.size, 0);
});
