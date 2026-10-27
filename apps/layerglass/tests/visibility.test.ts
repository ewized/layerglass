import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { loadBrowserModule } from './browser-module.ts';
import { testDouble } from './test-doubles.ts';

async function surface() {
  const document = Object.assign(new EventTarget(), { hidden: false });
  const window = new EventTarget();
  const floating = Object.assign(new EventTarget(), { hidden: false });
  let changes = 0;
  window.addEventListener('playerviewchange', () => changes++);
  const visibility = await loadBrowserModule('visibility.js', vm.createContext({ document, window, Event }));
  return {
    ...visibility,
    document,
    floating,
    changes: () => changes,
    setPlayerDocument: (doc: typeof document) => visibility.setPlayerDocument(testDouble<Document>(doc)),
  };
}

test('normal playback visibility follows the page', async () => {
  const h = await surface();
  assert.equal(h.playerVisible(), true);
  h.document.hidden = true;
  assert.equal(h.playerVisible(), false);
});

test('a visible floating player continues when its opener is hidden', async () => {
  const h = await surface();
  h.setPlayerDocument(h.floating);
  h.document.hidden = true;
  assert.equal(h.playerVisible(), true);
  h.floating.hidden = true;
  h.floating.dispatchEvent(new Event('visibilitychange'));
  assert.equal(h.playerVisible(), false);
  assert.equal(h.changes(), 2);
});

test('Restore follows opener visibility and removes listeners from the old window', async () => {
  const h = await surface();
  h.setPlayerDocument(h.floating);
  h.document.hidden = true;
  h.setPlayerDocument(h.document);
  assert.equal(h.playerVisible(), false);
  h.floating.dispatchEvent(new Event('visibilitychange'));
  assert.equal(h.changes(), 2, 'The closed window must no longer notify transports.');
  h.document.hidden = false;
  assert.equal(h.playerVisible(), true);
});

test('native browser PiP keeps playback visible while the tab is hidden', async () => {
  const h = await surface();
  h.document.hidden = true;
  h.setNativePictureInPicture(true);
  assert.equal(h.playerVisible(), true);
  h.setNativePictureInPicture(true);
  assert.equal(h.changes(), 1, 'Repeated PiP events must not reconnect transports.');
  h.setNativePictureInPicture(false);
  assert.equal(h.playerVisible(), false);
  assert.equal(h.changes(), 2, 'Closing PiP must restore hidden-tab suspension.');
});

test('a cast receiver keeps metadata and the recording lease alive while the tab is hidden', async () => {
  const h = await surface();
  h.document.hidden = true;
  h.setRemotePlayback(true);
  assert.equal(h.playerVisible(), true);
  h.setRemotePlayback(true);
  assert.equal(h.changes(), 1);
  h.setNativePictureInPicture(true);
  h.setRemotePlayback(false);
  assert.equal(h.playerVisible(), true, 'Ending casting must not suspend an existing native PiP window.');
  h.setNativePictureInPicture(false);
  assert.equal(h.playerVisible(), false);
});
