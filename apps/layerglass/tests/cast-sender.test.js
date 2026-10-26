import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { loadBrowserModule } from './browser-module.js';
import { installCastFixture } from './cast-fixture.js';

const path = `/replay/${'a'.repeat(32)}/live.m3u8`;
async function harness() {
  const view = { isSecureContext: true, chrome: {}, PresentationRequest() {},
    navigator: { presentation: {}, userActivation: { isActive: true } } };
  const sdk = installCastFixture(view);
  const video = { paused: false, currentTime: 40 };
  const replay = { session: { start_seconds: 0, end_seconds: 100 }, paused: false, followLive: true,
    position: 40, remote: null, bounds: () => ({ start: 0, current: 40, end: 100 }),
    setRemote(remote, resume = true) { this.remote = remote; this.resume = resume; if (remote) video.paused = true; },
    render() {} };
  Object.defineProperty(replay, 'reviewing', { get: () => !replay.followLive || replay.paused });
  const module = await loadBrowserModule('cast-sender.js', vm.createContext({
    window: view, location: new URL('https://printer.test/'), URL, DOMException, setTimeout, clearTimeout,
    console: { warn() {} },
  }));
  let changes = 0;
  const sender = new module.GoogleCastSender(video, replay, () => ({ model: 'Printer model', id: '123' }), () => changes++);
  sender.setSource(path);
  await sender.initializing;
  return { sender, sdk, video, replay, view, module, changes: () => changes };
}

async function loaderHarness() {
  const scripts = [], timers = new Map();
  const view = { isSecureContext: true, chrome: {}, PresentationRequest() {},
    navigator: { presentation: {}, userActivation: { isActive: true } },
    document: { createElement: () => ({ remove() { this.removed = true; } }),
      head: { append: script => scripts.push(script) } } };
  const module = await loadBrowserModule('cast-sender.js', vm.createContext({
    window: view, location: new URL('https://printer.test/'), URL, DOMException,
    setTimeout(fn) { const id = {}; timers.set(id, fn); return id; },
    clearTimeout: id => timers.delete(id), console: { warn() {} },
  }));
  const video = { paused: false, currentTime: 0 };
  const replay = { paused: false, session: { start_seconds: 0 },
    setRemote() {}, render() {}, bounds: () => ({ start: 0, current: 0, end: 100 }) };
  const sender = new module.GoogleCastSender(video, replay, () => ({ model: 'Fixture', id: '123' }), () => {});
  sender.setSource(path);
  return { scripts, timers, view, module, sender };
}

test('failed Cast SDK loading releases its callback/script and explicit source refresh retries once', async () => {
  const { scripts, timers, view, module, sender } = await loaderHarness();
  const first = sender.initializing;
  assert.equal(sender.initialize(), first, 'Concurrent initialization shares one attempt.');
  assert.equal(module.loadCastSDK(view), module.loadCastSDK(view));
  assert.equal(scripts.length, 1);
  const oldCallback = view.__onGCastApiAvailable;
  scripts[0].onerror();
  await first;
  assert.equal(sender.state, 'unavailable');
  assert.equal(sender.initializing, null);
  assert.equal(scripts[0].removed, true);
  assert.equal(view.__onGCastApiAvailable, undefined);
  assert.equal(timers.size, 0, 'Failure cannot leave a timeout or autonomous retry loop.');

  sender.setSource(path);
  const second = sender.initializing, currentCallback = view.__onGCastApiAvailable;
  sender.setSource(path);
  assert.equal(scripts.length, 2, 'An explicit refresh retries exactly once.');
  oldCallback(false);
  assert.equal(view.__onGCastApiAvailable, currentCallback, 'A late failed callback cannot remove the newer attempt.');
  assert.equal(sender.state, 'loading');
  const sdk = installCastFixture(view);
  await second;
  assert.equal(sender.ready, true);
  assert.equal(timers.size, 0);
  sender.setSource(path);
  assert.equal(scripts.length, 2);
  assert.equal(sdk.controller.listeners.get('change').length, 1);
  assert.equal(view.cast.framework.CastContext.getInstance().listeners.get('session').length, 1);
  const pending = sender.request();
  assert.equal(sdk.requests[0].activated, true, 'The successful retry keeps picker activation synchronous.');
  await pending;
});

test('Cast SDK timeout restores a previous callback and leaves loading retryable', async () => {
  const { scripts, timers, view, module, sender } = await loaderHarness();
  scripts[0].onerror();
  await sender.initializing;
  const previous = () => {};
  view.__onGCastApiAvailable = previous;
  const timedOut = module.loadCastSDK(view);
  const rejected = assert.rejects(timedOut, { name: 'TimeoutError' });
  [...timers.values()][0]();
  await rejected;
  assert.equal(view.__onGCastApiAvailable, previous);
  assert.equal(scripts[1].removed, true);
  assert.equal(timers.size, 0);
  const retry = module.loadCastSDK(view);
  assert.equal(scripts.length, 3);
  const currentCallback = view.__onGCastApiAvailable;
  installCastFixture(view);
  await retry;
  assert.equal(view.__onGCastApiAvailable, currentCallback, 'Successful loading keeps the vendor callback behavior.');
});

test('partial Cast framework setup rolls back its listeners before an explicit retry', async () => {
  for (const stage of ['setOptions', 'addEventListener']) {
    const { view, sender } = await loaderHarness();
    const sdk = installCastFixture(view);
    const context = view.cast.framework.CastContext.getInstance();
    const original = context[stage];
    context[stage] = function(...args) {
      if (stage === 'addEventListener') original.apply(this, args);
      throw new Error('Synthetic partial Cast framework failure.');
    };
    await sender.initializing;
    const abandoned = sdk.controller;
    assert.equal(sender.state, 'unavailable');
    assert.equal(sender.initializing, null);
    assert.equal(context.listeners.get('session').length, 0);
    assert.equal(abandoned.listeners.get('change').length, 0);
    assert.equal(sender.context, null);
    context[stage] = original;
    sender.setSource(path);
    await sender.initializing;
    assert.equal(sender.ready, true);
    assert.equal(context.listeners.get('session').length, 1);
    assert.equal(sdk.controller.listeners.get('change').length, 1);
    let changes = 0;
    sender.changed = () => changes++;
    abandoned.emit('change');
    assert.equal(changes, 0);
    context.emit('session');
    assert.equal(changes, 1, 'One SDK session event produces one callback after retry.');
  }
});

test('Google Cast sends the network live playlist and identity, never a decoder blob', async () => {
  const { sender, sdk, replay, video } = await harness();
  assert.equal(sender.ready, true);
  assert.equal(sdk.options.autoJoinPolicy, 'tab');
  assert.equal(sdk.options.resumeSavedSession, false);
  sdk.holdSession = true;
  const pending = sender.request();
  assert.equal(sdk.requests[0].activated, true);
  assert.equal(sdk.requests.length, 1, 'The picker is called synchronously, before awaiting.');
  assert.equal(video.paused, false, 'Opening the picker must keep local playback running.');
  assert.equal(replay.remote, null);
  sdk.finishSession();
  await pending;
  const request = sdk.loads[0];
  assert.equal(request.media.contentId, `https://printer.test${path}`);
  assert.equal(request.media.contentType, 'application/vnd.apple.mpegurl');
  assert.equal(request.media.streamType, 'live');
  assert.equal(request.media.metadata.title, 'Printer model');
  assert.equal(request.media.metadata.subtitle, '123');
  assert.equal(request.autoplay, true);
  assert.equal(request.currentTime, undefined, 'Live starts at the receiver live edge.');
  assert.equal(sender.active, true);
  assert.equal(replay.remote, sender);
  assert.equal(video.paused, true, 'Local decoding pauses only after the receiver loaded the stream.');
});

test('cancelled or failed Cast selection cannot pause or replace the local player', async () => {
  const { sender, sdk, replay, video } = await harness();
  sdk.failSession = 'cancel';
  await assert.rejects(sender.request(), error => error === 'cancel');
  assert.equal(sender.pending, false);
  assert.equal(sender.connected, false);
  assert.equal(replay.remote, null);
  assert.equal(video.paused, false);
  assert.equal(sdk.loads.length, 0);
  assert.equal(sdk.stops, 0);
});

test('a receiver load failure stops its empty session and preserves local playback', async () => {
  const { sender, sdk, replay, video } = await harness();
  sdk.failLoad = 'load_media_failed';
  await assert.rejects(sender.request(), error => error === 'load_media_failed');
  assert.equal(sender.connected, false);
  assert.equal(replay.remote, null);
  assert.equal(video.paused, false);
  assert.equal(sdk.stops, 1);
});

test('replay casts the watched moment and receiver progress drives the shared clock', async () => {
  const { sender, sdk, replay } = await harness();
  replay.followLive = false;
  replay.paused = true;
  await sender.request();
  assert.equal(sdk.loads[0].currentTime, 40);
  assert.equal(sdk.loads[0].autoplay, false);
  assert.equal(sender.paused, true);
  sender.play();
  assert.equal(replay.paused, false);
  sdk.advance(50);
  assert.equal(replay.position, 50);
  assert.equal(sender.bounds().current, 50);
  sender.togglePause();
  assert.equal(replay.paused, true);
  sender.seek(25);
  assert.equal(replay.position, 25);
  assert.equal(sdk.controls.at(-1).seek, 25);
  sender.goLive();
  assert.equal(sender.bounds().current, 98);
  assert.equal(replay.paused, false);
});

test('printer changes during the picker cannot cast a stale printer or retain a receiver', async () => {
  const { sender, sdk, replay } = await harness();
  sdk.holdSession = true;
  const pending = sender.request();
  sender.setSource(`/replay/${'b'.repeat(32)}/live.m3u8`);
  sdk.finishSession();
  await pending;
  assert.equal(sdk.loads.length, 0);
  assert.equal(sdk.stops, 1);
  assert.equal(sender.connected, false);
  assert.equal(replay.remote, null);
});

test('disconnect restores local transport, and forgetting stops only the owned cast', async () => {
  const { sender, sdk, replay } = await harness();
  await sender.request();
  sdk.advance(70);
  sdk.disconnect();
  assert.equal(replay.remote, null);
  assert.equal(replay.resume, true);
  assert.equal(sender.connected, false);
  await sender.request();
  sender.clearSource();
  assert.equal(replay.remote, null);
  assert.equal(replay.resume, false, 'Changing printer must not resume the previous printer.');
  assert.equal(sender.source, null);
  assert.equal(sdk.stops, 1);
});

test('a receiver that unloads its media releases the remote transport', async () => {
  const { sender, sdk, replay } = await harness();
  await sender.request();
  sdk.player.isMediaLoaded = false;
  sdk.controller.emit('change');
  assert.equal(sender.active, false);
  assert.equal(replay.remote, null);
  assert.equal(replay.resume, true);
});

test('Cast is capability-based, excludes Safari and rejects non-printer or external URLs', async () => {
  const { sender, view, video, module } = await harness();
  assert.equal(module.castPlatform({}, view), true);
  assert.equal(module.castPlatform({ webkitShowPlaybackTargetPicker() {} }, view), false);
  assert.equal(module.castPlatform({}, { ...view, isSecureContext: false }), false);
  assert.equal(module.castPlatform({}, { ...view, PresentationRequest: undefined }), false);
  view.isSecureContext = false;
  video.currentSrc = 'blob:http://printer.test/decoder';
  assert.equal(sender.needsHTTPS, true);
  video.currentSrc = 'http://printer.test/native-video.mp4';
  assert.equal(sender.needsHTTPS, false, 'Native remoting from a network source keeps its existing behavior.');
  for (const url of ['blob:decoder', 'https://another.test/camera/live.m3u8', '/api/cameras', '/static/live.m3u8']) {
    sender.setSource(url);
    assert.equal(sender.ready, false);
  }
  assert.equal(module.castError('cancel'), 'cancel');
  assert.equal(module.castError(new DOMException('Denied', 'NotAllowedError')), 'NotAllowedError');
  assert.equal(module.castError(undefined), 'Error');
});
