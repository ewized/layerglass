import assert from 'node:assert/strict';
import test from 'node:test';
import { debugInfo, writeDebugClipboard } from '../src/debug-info.js';

function fixture() {
  const recorded = { progress: 10, reported: { print: { ams: [{ id: '0', humidity: 4 }], enabled: false, count: 0 } } };
  const live = { progress: 20, reported: { print: { ams: [{ id: '0', humidity: 5 }],
    future_sensor: { coefficient: 0.00000321 }, fan_speed: 1, fanSpeed: 2 } } };
  const video = { currentTime: 3, duration: Infinity, videoWidth: 1920, videoHeight: 1080,
    paused: true, seeking: false, playbackRate: 1, readyState: 4, networkState: 2,
    getVideoPlaybackQuality: () => ({ totalVideoFrames: 90, droppedVideoFrames: 1 }),
    buffered: { length: 1, start: () => 0, end: () => 12 }, seekable: { length: 0 } };
  const player = { clientWidth: 414, clientHeight: 896, classList: { contains: () => false } };
  const view = { navigator: { userAgent: 'Fixture browser', language: 'en', onLine: true },
    isSecureContext: true, devicePixelRatio: 3,
    document: { visibilityState: 'visible' }, location: { href: 'https://viewer.test/?access_code=private' } };
  const state = { camera: { id: 'camera', host: '192.168.4.104', port: 322, access_code: 'private', source: 'rtsps://private' },
    printer: live, printerHistory: { peek: at => { assert.equal(at, 1003); return recorded; }, read: () => { throw new Error('Copy must not fetch history'); } },
    replay: { session: { kind: 'hls', session_id: 'private-session' }, paused: true, position: 3,
      bounds: () => ({ start: 0, end: 20, current: 3 }) }, hls: { playingDate: new Date(1003000) },
    videoStream: { connected: true, mediaBitrate: 4000000 }, videoCodec: 'avc1.640028',
    server: { state: 'live', restarts: 0, source: 'rtsps://private' },
    discovery: { state: 'done', checked: 256, total: 256, cached: 12 } };
  return { state, media: { video, player, image: { hidden: true } }, view, live, recorded };
}

test('debug JSON retains every extra field alongside distinct watched and live readings', () => {
  const { state, media, view, live, recorded } = fixture();
  const report = debugInfo(state, media, view, 1700000000000);
  assert.deepEqual(report.printer.live, live);
  assert.deepEqual(report.printer.displayed, recorded);
  assert.equal(report.playback.mode, 'paused');
  assert.equal(report.playback.displayed_at, '1970-01-01T00:16:43.000Z');
  assert.equal(report.playback.recorded_printer_available, true);
  assert.deepEqual(report.video.resolution, [1920, 1080]);
  assert.deepEqual(report.video.buffered, [[0, 12]]);
  assert.equal(report.video.native_live, true);
  const encoded = JSON.stringify(report, null, 2);
  assert(!encoded.includes('private'));
  assert.equal(JSON.parse(encoded).printer.live.reported.print.future_sensor.coefficient, 0.00000321);
  assert.equal(JSON.parse(encoded).printer.displayed.reported.print.enabled, false);
});

test('uncached recorded data stays explicitly unknown and does not trigger a request', () => {
  const { state, media, view, live } = fixture();
  state.printerHistory.peek = () => null;
  const report = debugInfo(state, media, view);
  assert.equal(report.printer.displayed, null);
  assert.equal(report.playback.recorded_printer_available, false);
  assert.deepEqual(report.printer.live, live);
  assert.equal(report.video.duration_seconds, null);
});

test('debug info recognizes native iPhone fullscreen without element fullscreen', () => {
  const { state, media, view } = fixture();
  media.player.classList.contains = name => name === 'native-fullscreen';
  assert.equal(debugInfo(state, media, view).playback.fullscreen, true);
});

test('the native clipboard write starts synchronously inside the action', async () => {
  let called = false;
  const document = { defaultView: { navigator: { clipboard: { writeText(text) {
    called = true;
    assert.equal(text, 'debug JSON');
    return Promise.resolve();
  } } } } };
  const pending = writeDebugClipboard(document, 'debug JSON');
  assert.equal(called, true);
  await pending;
});

test('a denied native clipboard write is reported instead of silently claiming success', async () => {
  const document = { defaultView: { navigator: { clipboard: { writeText: () => Promise.reject(new Error('Denied')) } } } };
  await assert.rejects(writeDebugClipboard(document, 'debug JSON'), /Denied/);
});

test('the HTTP fallback cleans up and restores focus even when copy fails', () => {
  const calls = [];
  const input = { setAttribute() {}, focus() { calls.push('focus input'); }, select() {}, setSelectionRange() {}, remove() { calls.push('remove'); } };
  const document = { defaultView: { navigator: {} },
    activeElement: { isConnected: true, focus() { calls.push('restore focus'); } },
    getSelection: () => null, createElement: () => input, body: { append() {} }, execCommand: () => false };
  assert.throws(() => writeDebugClipboard(document, 'debug JSON'), /Clipboard unavailable/);
  assert.deepEqual(calls, ['focus input', 'remove', 'restore focus']);
});
