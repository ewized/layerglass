import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { loadBrowserModule } from './browser-module.js';

const key = 'printerCameraReload';
const now = 1780000000000;
const intent = overrides => ({ version: 1, reason: 'pull-to-refresh', autoplay: true,
  cameraId: 'printer-2', requestedAt: now, ...overrides });

async function harness(state = null, navigation = 'reload', denyHistory = false) {
  const history = { state, length: 1, replaceState(next) {
    if (denyHistory) throw new Error('History unavailable');
    this.state = structuredClone(next);
  } };
  let reloads = 0;
  const indicator = { hidden: true, style: { setProperty() {} }, classList: { toggle() {}, add() {} } };
  const label = { textContent: 'Pull to reload' };
  const panel = { hidden: true };
  const context = vm.createContext({ history, Date: { now: () => now },
    performance: { now: () => 10, getEntriesByType: () => [{ type: navigation }] },
    window: { location: { reload() { reloads++; } }, scrollY: 0, addEventListener() {} },
    document: { getElementById: id => ({ 'pull-refresh': indicator, 'pull-refresh-label': label, 'player-options': panel })[id] } });
  const { PlayerReload, PlayerPullRefresh } = await loadBrowserModule('refresh.js', context);
  const pull = new PlayerPullRefresh({ addEventListener() {} }, () => PlayerReload.reload('printer-2'));
  return { PlayerReload, pull, history, indicator, label, panel, reloads: () => reloads };
}

function touch(type, x, y, { target = 'surface', count = type === 'end' ? 0 : 1, cancelable = true } = {}) {
  return { touches: Array.from({ length: count }, (_, identifier) => ({ clientX: x, clientY: y, identifier })),
    cancelable, prevented: false, preventDefault() { this.prevented = true; },
    target: { closest(selector) { return selector === '#viewer' ? target === 'surface' || target === 'button' : target === 'button'; } } };
}

test('reload records only camera/autoplay metadata, keeps other state, and performs one navigation', async () => {
  const h = await harness({ unrelated: { nested: true } });
  h.PlayerReload.reload('printer-2');
  assert.deepEqual(h.history.state, { unrelated: { nested: true }, [key]: intent() });
  assert.equal(h.history.length, 1);
  assert.equal(h.reloads(), 1);
});

test('reload intent is consumed once and unrelated state survives', async () => {
  const h = await harness({ unrelated: 42, [key]: intent() });
  assert.deepEqual(JSON.parse(JSON.stringify(h.PlayerReload.consume())), intent());
  assert.deepEqual(h.history.state, { unrelated: 42 });
  assert.equal(h.PlayerReload.consume(), null);
});

test('a reload begun before the app rename still autoplays and removes legacy metadata', async () => {
  const h = await harness({ unrelated: 42, bambuPlayerReload: intent() });
  assert.deepEqual(JSON.parse(JSON.stringify(h.PlayerReload.consume())), intent());
  assert.deepEqual(h.history.state, { unrelated: 42 });
  assert.equal(h.PlayerReload.consume(), null);
});

test('plain navigation does not resume stale reload intent', async () => {
  for (const type of ['navigate', 'back_forward']) {
    const h = await harness({ [key]: intent() }, type);
    assert.equal(h.PlayerReload.consume(), null);
    assert.deepEqual(h.history.state, {});
  }
});

test('expired, future, malformed and foreign intent is discarded', async () => {
  for (const invalid of [null, false, {}, intent({ version: 2 }), intent({ reason: 'other' }),
    intent({ autoplay: false }), intent({ requestedAt: now - 120001 }), intent({ requestedAt: now + 1 }),
    intent({ requestedAt: String(now) }), intent({ requestedAt: NaN }), intent({ cameraId: {} }),
    intent({ cameraId: '' }), intent({ cameraId: 'x'.repeat(129) })]) {
    const h = await harness({ unrelated: true, [key]: invalid });
    assert.equal(h.PlayerReload.consume(), null);
    assert.deepEqual(h.history.state, { unrelated: true });
  }
});

test('reload works before a camera is selected', async () => {
  const h = await harness();
  h.PlayerReload.reload(null);
  assert.equal(h.history.state[key].cameraId, null);
  assert.equal(h.PlayerReload.consume().autoplay, true);
});

test('history failure still reloads, and an uncleared intent is never consumed', async () => {
  const h = await harness({ [key]: intent() }, 'reload', true);
  assert.equal(h.PlayerReload.consume(), null);
  h.PlayerReload.reload('printer-2');
  assert.equal(h.reloads(), 1);
});

test('a deliberate downward pull arms at the threshold and reloads on release only', async () => {
  const h = await harness();
  h.pull.start(touch('start', 100, 100));
  const move = touch('move', 105, 195);
  h.pull.move(move);
  assert.equal(move.prevented, true);
  assert.equal(h.indicator.hidden, false);
  assert.equal(h.label.textContent, 'Release to reload');
  assert.equal(h.reloads(), 0);
  h.pull.end(touch('end', 105, 195));
  assert.equal(h.reloads(), 1);
  assert.equal(h.label.textContent, 'Reloading…');
  h.pull.start(touch('start', 100, 100));
  h.pull.move(touch('move', 100, 250));
  h.pull.end(touch('end', 100, 250));
  assert.equal(h.reloads(), 1, 'A pending reload cannot be triggered twice.');
});

test('short pulls and pulling back below threshold do not reload', async () => {
  for (const movements of [[30], [100, 30]]) {
    const h = await harness();
    h.pull.start(touch('start', 100, 100));
    for (const dy of movements) h.pull.move(touch('move', 100, 100 + dy));
    h.pull.end(touch('end', 100, 100));
    assert.equal(h.reloads(), 0);
    assert.equal(h.indicator.hidden, true);
  }
});

test('upward and horizontal gestures never turn into refresh gestures', async () => {
  for (const [x, y] of [[100, 50], [160, 120]]) {
    const h = await harness();
    h.pull.start(touch('start', 100, 100));
    const move = touch('move', x, y);
    h.pull.move(move);
    assert.equal(move.prevented, false);
    h.pull.move(touch('move', 100, 250));
    h.pull.end(touch('end', 100, 250));
    assert.equal(h.reloads(), 0);
  }
});

test('controls, timeline, and open menu gestures cannot refresh', async () => {
  for (const target of ['button', 'slider', 'menu']) {
    const h = await harness();
    h.pull.start(touch('start', 100, 100, { target }));
    h.pull.move(touch('move', 100, 250));
    h.pull.end(touch('end', 100, 250));
    assert.equal(h.reloads(), 0);
  }
  const h = await harness();
  h.panel.hidden = false;
  h.pull.start(touch('start', 100, 100));
  h.pull.move(touch('move', 100, 250));
  h.pull.end(touch('end', 100, 250));
  assert.equal(h.reloads(), 0);
});

test('multitouch, cancellation, and a gesture captured by the browser abort refresh', async () => {
  for (const action of ['multitouch', 'cancel', 'browser']) {
    const h = await harness();
    h.pull.start(touch('start', 100, 100));
    h.pull.move(touch('move', 100, 200));
    if (action === 'cancel') h.pull.reset();
    else h.pull.move(touch('move', 100, 250, { count: action === 'multitouch' ? 2 : 1, cancelable: action !== 'browser' }));
    h.pull.end(touch('end', 100, 250));
    assert.equal(h.reloads(), 0);
    assert.equal(h.indicator.hidden, true);
  }
});
