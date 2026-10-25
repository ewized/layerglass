import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { loadBrowserModule } from './browser-module.js';

class Element extends EventTarget {
  constructor() { super(); this.attributes = new Map(); this.children = []; this.hidden = false; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  hasAttribute(name) { return this.attributes.has(name); }
  getAttribute(name) { return this.attributes.get(name); }
  querySelector(selector) { return this.children.find(child => selector === 'source' || child.hasAttribute('data-cast-source')); }
  appendChild(child) { this.children.push(child); child.remove = () => { this.children = this.children.filter(item => item !== child); }; }
}

async function harness(options = {}) {
  const player = new EventTarget();
  const button = new Element();
  player.querySelector = () => button;
  const video = new Element();
  Object.assign(video, { readyState: 4, paused: false, ended: false, currentTime: 42, playbackRate: 1,
    ownerDocument: { createElement: () => new Element() } });
  const remote = new EventTarget();
  remote.state = 'disconnected';
  const calls = { prompts: 0, webkit: 0, plays: 0, pauses: 0, mini: 0, live: 0, seeks: [], remote: [], positions: [], warnings: [] };
  if (options.remote !== false) {
    remote.prompt = () => { calls.prompts++; return options.prompt?.() ?? Promise.resolve(); };
    video.remote = remote;
  }
  if (options.webkit) video.webkitShowPlaybackTargetPicker = () => { calls.webkit++; };
  const actions = new Map();
  const session = {
    metadata: null,
    setActionHandler(name, handler) {
      if (name === options.unsupportedAction) throw new TypeError('Unsupported action');
      if (handler) actions.set(name, handler);
      else actions.delete(name);
    },
    setPositionState(state) {
      calls.positions.push(state);
    },
  };
  const replay = {
    session: { ready: true },
    hasHistory: true,
    bounds: () => ({ start: 20, current: video.currentTime, end: 120 }),
    togglePause: () => { calls.pauses++; video.paused = true; video.dispatchEvent(new Event('pause')); },
    seek: value => { calls.seeks.push(Math.max(20, Math.min(119.95, value))); },
    goLive: () => { calls.live++; },
  };
  const window = new EventTarget();
  const context = vm.createContext({ window, AbortController, navigator: options.noMediaSession ? {} : { mediaSession: session },
    location: { href: 'https://printer.test/' }, URL, Event,
    MediaMetadata: class { constructor(metadata) { Object.assign(this, metadata); } },
    console: { debug: (...args) => calls.warnings.push(args), warn: (...args) => calls.warnings.push(args) } });
  const { PlayerMedia } = await loadBrowserModule('player-media.js', context, {
    './visibility.js': { setRemotePlayback: value => calls.remote.push(value) },
  });
  const media = new PlayerMedia(player, video, replay, {
    play: () => { calls.plays++; video.paused = false; video.dispatchEvent(new Event('play')); },
    mini: () => { calls.mini++; },
  });
  media.setIdentity('Printer model', 'PRINTER-123');
  if (options.source !== false) media.setSource('/replay/session/live.m3u8');
  return { player, button, video, remote, media, replay, session, actions, calls };
}

test('Cast invokes the native picker in the click activation, without replacing playback', async () => {
  let resolve;
  const h = await harness({ prompt: () => new Promise(done => { resolve = done; }) });
  h.video.src = 'blob:original-decoder';
  h.player.dispatchEvent(new Event('cast-request'));
  assert.equal(h.calls.prompts, 1, 'The prompt must run synchronously from the click event.');
  assert.equal(h.button.disabled, true);
  h.player.dispatchEvent(new Event('cast-request'));
  assert.equal(h.calls.prompts, 1, 'An open picker must not be requested again.');
  assert.equal(h.video.src, 'blob:original-decoder');
  assert.equal(h.video.currentTime, 42);
  assert.deepEqual(h.calls.seeks, []);
  resolve();
  await new Promise(setImmediate);
  assert.equal(h.button.disabled, false);
  assert.equal(h.media.remoteActive, false, 'Closing a picker is not proof of an active receiver.');
});

test('Safari prefers its AirPlay picker and offers HLS beside ManagedMediaSource', async () => {
  const h = await harness({ webkit: true, source: false });
  const primary = new Element();
  primary.src = 'blob:native-managed-media-source';
  h.video.appendChild(primary);
  h.video.disableRemotePlayback = true;
  h.video.load = () => assert.fail('Adding an alternative must not reload the primary decoder.');
  h.media.setSource('/replay/session/live.m3u8');
  assert.equal(h.video.disableRemotePlayback, false);
  assert.equal(h.video.children.length, 2);
  assert.equal(h.video.children[0], primary);
  assert.equal(h.video.children[1].src, 'https://printer.test/replay/session/live.m3u8');
  assert.equal(h.video.children[1].type, 'application/x-mpegURL');
  h.media.setSource('/replay/new/live.m3u8');
  assert.equal(h.video.children.length, 2, 'Media recovery must update the alternative, not accumulate sources.');
  h.player.dispatchEvent(new Event('cast-request'));
  assert.equal(h.calls.webkit, 1);
  assert.equal(h.calls.prompts, 0);
  h.media.clearSource();
  assert.deepEqual(h.video.children, [primary]);
});

test('native casting state controls its indicator and background metadata lifetime', async () => {
  const h = await harness();
  for (const [state, event] of [['connecting', 'connecting'], ['connected', 'connect'], ['disconnected', 'disconnect']]) {
    h.remote.state = state;
    h.remote.dispatchEvent(new Event(event));
    const active = state !== 'disconnected';
    assert.equal(h.media.remoteActive, active);
    assert.equal(h.button.getAttribute('aria-pressed'), String(active));
    h.video.dispatchEvent(new Event('timeupdate'));
    h.video.dispatchEvent(new Event('play'));
    assert.equal(h.button.title, active ? 'Manage casting' : 'Cast');
  }
  assert.deepEqual(h.calls.remote, [true, false]);
});

test('Safari wireless events follow browser-initiated AirPlay as well as our button', async () => {
  const h = await harness({ webkit: true });
  h.video.webkitCurrentPlaybackTargetIsWireless = true;
  h.video.dispatchEvent(new Event('webkitcurrentplaybacktargetiswirelesschanged'));
  assert.equal(h.media.remoteActive, true);
  h.video.webkitCurrentPlaybackTargetIsWireless = false;
  h.video.dispatchEvent(new Event('webkitcurrentplaybacktargetiswirelesschanged'));
  assert.equal(h.media.remoteActive, false);
  assert.deepEqual(h.calls.remote, [true, false]);
});

test('cancelled casting leaves playback and media metadata intact', async () => {
  const h = await harness({ prompt: () => Promise.reject(new DOMException('Dismissed', 'NotAllowedError')) });
  const metadata = h.session.metadata;
  await h.media.cast();
  assert.equal(h.button.disabled, false);
  assert.equal(h.media.remoteActive, false);
  assert.equal(h.session.metadata, metadata);
  assert.equal(h.calls.warnings.length, 1);
  assert.equal(h.video.currentTime, 42);
});

test('Cast stays disabled for unsupported browsers, unloaded video and JPEG cameras', async () => {
  const unsupported = await harness({ remote: false });
  assert.equal(unsupported.button.disabled, true);
  await unsupported.media.cast();
  assert.equal(unsupported.calls.prompts, 0);
  const h = await harness();
  for (const state of [{ readyState: 0, hidden: false }, { readyState: 4, hidden: true }]) {
    Object.assign(h.video, state);
    h.media.update();
    assert.equal(h.button.disabled, true);
    assert.equal(h.session.metadata, null);
    assert.equal(h.session.playbackState, 'none');
    assert.equal(h.actions.size, 0);
  }
});

test('Media Session publishes printer identity and controls the existing playback and DVR', async () => {
  const h = await harness();
  assert.equal(h.session.metadata.title, 'Printer model');
  assert.equal(h.session.metadata.artist, 'PRINTER-123');
  assert.equal(h.session.metadata.artwork[0].src, 'https://printer.test/static/icons/icon-512.png');
  assert.equal(h.session.playbackState, 'playing');
  h.actions.get('play')();
  assert.equal(h.calls.plays, 0, 'Repeated Play must not pause or restart an already playing video.');
  h.actions.get('pause')();
  h.actions.get('pause')();
  assert.equal(h.calls.pauses, 1);
  assert.equal(h.session.playbackState, 'paused');
  h.actions.get('play')();
  assert.equal(h.calls.plays, 1);
  assert.equal(h.session.playbackState, 'playing');
  h.actions.get('seekbackward')({});
  h.actions.get('seekforward')({ seekOffset: 5 });
  h.actions.get('seekto')({ seekTime: 0 });
  h.actions.get('seekto')({ seekTime: 500 });
  h.actions.get('seekto')({ seekTime: NaN });
  assert.deepEqual(h.calls.seeks, [32, 47, 20, 119.95]);
  h.actions.get('seekto')({ seekTime: Infinity });
  assert.equal(h.calls.live, 1);
  h.actions.get('enterpictureinpicture')();
  assert.equal(h.calls.mini, 1);
  h.media.setIdentity('Different model', 'PRINTER-456');
  assert.equal(h.session.metadata.artist, 'PRINTER-456');
  h.media.clearSource();
  assert.equal(h.session.metadata, null);
  assert.equal(h.session.playbackState, 'none');
  assert.equal(h.actions.size, 0, 'Switching/forgetting a printer must clear stale media controls.');
});

test('system position remains owned by native video without manual position updates', async () => {
  const h = await harness();
  for (let count = 0; count < 20; count++) {
    h.video.currentTime = 42 + count / 100;
    h.video.dispatchEvent(new Event('timeupdate'));
  }
  assert.equal(h.calls.positions.length, 0);
  h.video.currentTime = 43;
  h.video.dispatchEvent(new Event('timeupdate'));
  assert.equal(h.calls.positions.length, 0);
  h.media.clearSource();
  assert.equal(h.calls.positions.length, 0);
});

test('the native LIVE flag follows live versus paused/replayed footage without trimming buffered frames', async () => {
  const h = await harness();
  const buffer = Object.assign(new EventTarget(), { updating: false, buffered: { length: 1, end: () => 123 } });
  const source = Object.assign(new EventTarget(), { readyState: 'open', sourceBuffers: [buffer], duration: Infinity });
  const pipeline = { config: { liveDurationInfinity: true } };
  h.media.setMediaSource(pipeline, source);
  assert.equal(source.duration, Infinity);
  h.replay.reviewing = true;
  h.video.paused = true;
  h.media.update();
  assert.equal(pipeline.config.liveDurationInfinity, false);
  assert.equal(source.duration, 123, 'The native replay duration must cover buffers newer than the last metadata snapshot.');
  assert.equal(h.video.currentTime, 42);
  h.video.paused = false;
  h.media.update();
  assert.equal(source.duration, 123, 'Resuming past footage must keep its replay state.');
  h.replay.reviewing = false;
  h.media.update();
  assert.equal(pipeline.config.liveDurationInfinity, true);
  assert.equal(source.duration, Infinity);
  assert.equal(h.calls.positions.length, 0, 'LIVE must use the native media clock without Media Session position overrides.');
});

test('LIVE changes wait for native buffer appends and apply the latest playback mode', async () => {
  const h = await harness();
  const buffer = Object.assign(new EventTarget(), { updating: true, buffered: { length: 1, end: () => 125 } });
  const source = Object.assign(new EventTarget(), { readyState: 'open', sourceBuffers: [buffer], duration: Infinity });
  h.media.setMediaSource({ config: { liveDurationInfinity: true } }, source);
  h.replay.reviewing = true;
  h.media.update();
  assert.equal(source.duration, Infinity, 'Writing duration during an append would throw InvalidStateError.');
  buffer.updating = false;
  buffer.dispatchEvent(new Event('updateend'));
  assert.equal(source.duration, 125);
  buffer.updating = true;
  h.replay.reviewing = false;
  h.media.update();
  h.replay.reviewing = true;
  h.media.update();
  buffer.updating = false;
  buffer.dispatchEvent(new Event('updateend'));
  assert.equal(source.duration, 125, 'A stale return-to-live request must not overwrite a newer rewind.');
});

test('source changes cancel pending native duration writes and cannot affect the next printer', async () => {
  const h = await harness();
  const buffer = Object.assign(new EventTarget(), { updating: true, buffered: { length: 1, end: () => 125 } });
  const source = Object.assign(new EventTarget(), { readyState: 'open', sourceBuffers: [buffer], duration: Infinity });
  h.media.setMediaSource({ config: { liveDurationInfinity: true } }, source);
  h.replay.reviewing = true;
  h.media.update();
  h.media.clearSource();
  buffer.updating = false;
  buffer.dispatchEvent(new Event('updateend'));
  source.dispatchEvent(new Event('sourceopen'));
  assert.equal(source.duration, Infinity);
  assert.equal(h.media.mediaSource, null);
});

test('returning to Live restores the newest seekable window after a long pause', async () => {
  const h = await harness();
  h.replay.reviewing = true;
  h.replay.session.end_seconds = 300;
  const ranges = [];
  const source = Object.assign(new EventTarget(), { readyState: 'open', sourceBuffers: [], duration: 120,
    setLiveSeekableRange: (start, end) => ranges.push([start, end]) });
  h.media.setMediaSource({ config: { liveDurationInfinity: false } }, source);
  assert.equal(source.duration, 300);
  h.replay.reviewing = false;
  h.media.update();
  assert.equal(source.duration, Infinity);
  assert.deepEqual(ranges, [[20, 300]], 'Restoring LIVE must not reuse the old seekable end from before the pause.');
});

test('system pause still controls live video when DVR session creation was unavailable', async () => {
  const h = await harness();
  h.replay.session = null;
  h.replay.hasHistory = false;
  h.video.pause = () => { h.calls.pauses++; h.video.paused = true; h.video.dispatchEvent(new Event('pause')); };
  h.actions.get('pause')();
  assert.equal(h.calls.pauses, 1);
  assert.equal(h.session.playbackState, 'paused');
  h.actions.get('play')();
  assert.equal(h.session.playbackState, 'playing');
});

test('partial Media Session support cannot break playback or casting', async () => {
  const h = await harness({ unsupportedAction: 'enterpictureinpicture' });
  assert(h.actions.has('pause'));
  assert(h.actions.has('seekto'));
  assert.equal(h.actions.has('enterpictureinpicture'), false);
  assert.equal(h.calls.positions.length, 0, 'Position support is unnecessary for a native video element.');
  const minimal = await harness({ noMediaSession: true });
  await minimal.media.cast();
  assert.equal(minimal.calls.prompts, 1);
});
