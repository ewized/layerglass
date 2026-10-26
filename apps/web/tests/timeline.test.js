import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { loadBrowserModule } from './browser-module.js';

// Exercise the shipped controller with deterministic media and clock inputs.
// Browser tests cover the actual range input, decoding, and pointer handling.
class Element extends EventTarget {
  constructor() {
    super();
    this.hidden = false;
    this.disabled = false;
    this.attributes = new Map();
    const style = new Map();
    this.style = { getPropertyValue: name => style.get(name) || '', setProperty: (name, value) => style.set(name, value) };
    this.classes = new Set();
    this.classList = {
      toggle: (name, enabled) => enabled ? this.classes.add(name) : this.classes.delete(name),
      remove: name => this.classes.delete(name)
    };
    for (const property of ['min', 'max', 'value']) {
      let value = '0';
      Object.defineProperty(this, property, { get: () => value, set: next => { value = String(next); } });
    }
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
}

async function player({ end = 100, current = 98, kind = 'hls', duration = Infinity } = {}) {
  let milliseconds = 0;
  let timerId = 0;
  const timers = new Map();
  const nodes = new Map();
  const document = Object.assign(new EventTarget(), { hidden: false, getElementById: id => {
    if (!nodes.has(id)) nodes.set(id, new Element());
    return nodes.get(id);
  } });
  const window = new EventTarget();
  const context = vm.createContext({ document, window, Event, CustomEvent, performance: { now: () => milliseconds },
    setInterval() {}, setTimeout(fn, delay) { timers.set(++timerId, { at: milliseconds + delay, fn }); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    fetch() { throw new Error('A timeline unit test must not use the network.'); } });
  const { PageReplay } = await loadBrowserModule('replay.js', context);
  const video = new Element();
  video.currentTime = current;
  video.duration = duration;
  video.paused = false;
  video.pause = () => { video.paused = true; video.dispatchEvent(new Event('pause')); };
  video.play = () => { video.paused = false; video.dispatchEvent(new Event('play')); return Promise.resolve(); };
  const replay = new PageReplay(video, new Element(), () => replay.session.end_seconds - 2);
  replay.session = { camera_id: 'fixture', kind, ready: true, start_seconds: 0, end_seconds: end,
    frame_url: '/fixture.jpg', error: null, limited: false };
  replay.position = current;
  video.seekable = { length: kind === 'hls' ? 1 : 0, start: () => replay.session.start_seconds,
    end: () => replay.session.end_seconds };
  replay.render();
  const slider = document.getElementById('replay-slider');
  slider.clientWidth = 416;
  const snapshot = () => ({ min: Number(slider.min), max: Number(slider.max), value: Number(slider.value) });
  const fraction = () => (Number(slider.value) - Number(slider.min)) / (Number(slider.max) - Number(slider.min));
  const advance = (seconds = 1, recorded = seconds, played = seconds) => {
    milliseconds += seconds * 1000;
    replay.session.end_seconds += recorded;
    if (!video.paused) video.currentTime += played;
    replay.tick();
  };
  const elapse = ms => {
    const end = milliseconds + ms;
    for (;;) {
      const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      milliseconds = next[1].at;
      timers.delete(next[0]);
      next[1].fn();
    }
    milliseconds = end;
  };
  return { replay, video, slider, document, window, advance, fraction, snapshot, elapse, timers };
}

const event = (type, properties = {}) => Object.assign(new Event(type, { cancelable: true }), properties);
const input = (p, value) => { p.slider.value = value; p.slider.dispatchEvent(new Event('input')); };

function close(actual, expected, message) {
  assert(Math.abs(actual - expected) < 1e-9, `${message}: expected ${expected}, got ${actual}`);
}

test('at Live, adding and playing one second keeps the thumb at the right edge', async () => {
  const p = await player();
  for (let second = 0; second < 120; second++) {
    p.advance();
    close(p.fraction(), 1, 'Live position');
  }
});

test('pausing from native PiP leaves Live and resuming keeps the selected past', async () => {
  const p = await player();
  p.video.pause();
  assert.equal(p.replay.followLive, false);
  assert.equal(p.replay.reviewing, true);
  p.advance(10, 10, 0);
  await p.video.play();
  assert.equal(p.replay.reviewing, true);
  assert.equal(p.replay.followLive, false);
  p.replay.goLive();
  assert.equal(p.replay.reviewing, false);
});

test('1× replay keeps its pixel fraction when playback and live each gain one second', async () => {
  const p = await player();
  p.replay.seek(50);
  const fraction = p.fraction();
  for (let second = 1; second <= 120; second++) {
    p.advance();
    close(p.fraction(), fraction, `Replay position after ${second}s`);
    close(p.video.currentTime, 50 + second, 'The fix must not seek or speed up the video');
  }
});

test('JPEG replay has the same 1× live-relative position as HLS', async () => {
  const p = await player({ kind: 'jpeg' });
  p.replay.seek(50);
  const fraction = p.fraction();
  for (let second = 1; second <= 30; second++) {
    p.advance();
    close(p.fraction(), fraction, 'JPEG replay position');
    close(p.replay.position, 50 + second, 'JPEG playback time');
  }
});

test('JPEG frame deduplication belongs to its session, including paused same-position seeks', async () => {
  const p = await player({ kind: 'jpeg' });
  const requests = [];
  let source;
  Object.defineProperty(p.replay.image, 'src', { get: () => source, set: value => { source = value; requests.push(value); } });
  p.replay.seek(30);
  p.replay.seek(30.2);
  assert.deepEqual(requests, ['/fixture.jpg?at=30'], 'Same-session requests still deduplicate by decoded frame position');
  const next = { ...p.replay.session, session_id: 'next-page', camera_id: 'next-camera', frame_url: '/next-camera.jpg' };
  p.replay.release = () => {};
  p.replay.close();
  p.replay.session = next;
  p.replay.attachMedia();
  p.replay.mediaReady();
  p.replay.image.src = '/next-camera-live.jpg';
  p.replay.togglePause();
  p.replay.seek(30.2);
  assert.equal(p.replay.image.src, '/next-camera.jpg?at=30', 'The replacement camera must request its own historical frame');
  assert.equal(p.replay.paused, true);
  close(p.replay.position, 30.2, 'Paused historical position');
  p.replay.seek(30.4);
  assert.equal(requests.length, 3, 'The new session also deduplicates repeated requests for one frame');
});

test('two-second segment batches do not make normal replay bounce each second', async () => {
  const p = await player();
  p.replay.seek(50);
  const fraction = p.fraction();
  for (let second = 1; second <= 30; second++) {
    p.advance(1, second % 2 === 0 ? 2 : 0);
    close(p.fraction(), fraction, `Segment batch at ${second}s`);
  }
});

test('six-second segment batches and 250ms UI ticks keep normal replay steady', async () => {
  const p = await player();
  p.replay.seek(50);
  const fraction = p.fraction();
  for (let tick = 1; tick <= 120; tick++) {
    p.advance(0.25, tick % 24 === 0 ? 6 : 0);
    close(p.fraction(), fraction, `Position at tick ${tick}`);
  }
});

test('faster playback moves toward Live instead of artificially freezing the thumb', async () => {
  const p = await player();
  p.replay.seek(50);
  for (let second = 1; second <= 10; second++) {
    p.advance(1, 1, 2);
    close(p.fraction(), 0.5 + second / 100, 'Catching up at 2×');
  }
});

test('a stalled playhead falls behind a stream that keeps growing', async () => {
  const p = await player();
  p.replay.seek(50);
  for (let second = 1; second <= 10; second++) {
    p.advance(1, 1, 0);
    close(p.fraction(), 0.5 - second / 100, 'Stalled playback');
  }
});

test('pause keeps the selected frame and bar still while its live delay increases', async () => {
  const p = await player();
  p.replay.togglePause();
  const paused = p.snapshot();
  for (let second = 0; second < 30; second++) p.advance();
  assert.deepEqual(p.snapshot(), paused);
  close(p.video.currentTime, 98, 'Paused frame');
  assert.equal(p.document.getElementById('replay-time').textContent, '−0:32');
});

test('resuming after a pause keeps the new behind-live position steady at 1×', async () => {
  const p = await player();
  p.replay.togglePause();
  for (let second = 0; second < 30; second++) p.advance();
  p.replay.togglePause();
  const fraction = p.fraction();
  for (let second = 0; second < 30; second++) {
    p.advance();
    close(p.fraction(), fraction, 'Resumed replay position');
  }
});

test('a held drag keeps its scale and chosen value while new segments arrive', async () => {
  const p = await player();
  p.replay.togglePause();
  p.slider.dispatchEvent(new Event('pointerdown'));
  p.slider.value = 25;
  p.slider.dispatchEvent(new Event('input'));
  const dragging = p.snapshot();
  for (let second = 0; second < 10; second++) p.advance();
  assert.deepEqual(p.snapshot(), dragging);
  close(p.video.currentTime, 98, 'Dragging must leave the paused video untouched');
  p.window.dispatchEvent(new Event('pointerup'));
  close(p.video.currentTime, 25, 'Only release commits the dragged frame');
  p.replay.togglePause();
  const fraction = p.fraction();
  p.advance();
  close(p.fraction(), fraction, 'Position after releasing and resuming');
});

test('starting another scrub exposes all retained page history after the window has moved', async () => {
  const p = await player();
  p.replay.seek(50);
  for (let second = 0; second < 60; second++) p.advance();
  p.slider.dispatchEvent(new Event('pointerdown'));
  close(Number(p.slider.min), 0, 'Oldest retained page footage must remain reachable');
  p.slider.value = 0.25;
  p.slider.dispatchEvent(new Event('input'));
  p.window.dispatchEvent(new Event('pointerup'));
  close(p.video.currentTime, 0.25, 'Scrub to earliest footage');
});

test('keyboard scrubbing also exposes the oldest retained footage', async () => {
  const p = await player();
  p.replay.seek(50);
  for (let second = 0; second < 60; second++) p.advance();
  const key = new Event('keydown');
  Object.defineProperty(key, 'key', { value: 'Home' });
  p.slider.dispatchEvent(key);
  close(Number(p.slider.min), 0, 'Keyboard access to the oldest footage');
  p.slider.value = 0.25;
  p.slider.dispatchEvent(new Event('input'));
  p.window.dispatchEvent(event('keyup', { key: 'Home' }));
  close(p.video.currentTime, 0.25, 'Keyboard seek target');
});

test('returning to Live while playing does not queue another asynchronous play', async () => {
  const p = await player();
  p.replay.seek(20);
  p.video.play = () => { throw new Error('Already playing'); };
  p.replay.goLive();
  p.video.pause();
  assert.equal(p.replay.paused, true);
  assert.equal(p.video.paused, true);
});

test('return to Live pins the playhead and hides the negative timer', async () => {
  const p = await player();
  p.replay.seek(50);
  p.advance();
  p.replay.goLive();
  close(p.fraction(), 1, 'Return to Live');
  assert.equal(p.document.getElementById('replay-time').hidden, true);
  for (let second = 0; second < 15; second++) {
    p.advance();
    close(p.fraction(), 1, 'Continuing Live playback');
  }
});

test('the interpolated display edge cannot seek into footage that has not arrived', async () => {
  const p = await player();
  p.replay.seek(50);
  p.advance(1, 0);
  p.slider.value = Number(p.slider.max);
  p.slider.dispatchEvent(new Event('input'));
  assert(p.video.currentTime < p.replay.session.end_seconds);
});

test('retention trimming prevents seeking into expired footage', async () => {
  const p = await player();
  p.replay.seek(50);
  p.replay.session.start_seconds = 40;
  p.replay.session.limited = true;
  p.advance();
  p.slider.dispatchEvent(new Event('pointerdown'));
  assert(Number(p.slider.min) >= 40);
  p.slider.value = 0;
  p.slider.dispatchEvent(new Event('input'));
  p.window.dispatchEvent(new Event('pointerup'));
  assert(p.video.currentTime >= 40);
});

test('many pointer positions preview without seeking, changing Live, or requesting printer history', async () => {
  const p = await player();
  let commits = 0;
  p.window.addEventListener('replaypositionchange', () => commits++);
  p.slider.dispatchEvent(event('pointerdown', { pointerId: 1, button: 0 }));
  for (let target = 10; target <= 80; target++) input(p, target);
  close(p.video.currentTime, 98, 'The native video must not seek during a drag');
  close(p.replay.previewPosition, 80, 'Only the draft target should move');
  assert.equal(p.replay.followLive, true);
  assert.equal(p.replay.paused, false);
  assert.equal(commits, 0);
  assert.equal(p.document.getElementById('replay-time').hidden, true, 'The bottom clock follows the actual video');
  assert.equal(p.slider.attributes.get('aria-valuetext'), '−0:20 from live');
  p.window.dispatchEvent(event('pointerup', { pointerId: 1 }));
  close(p.video.currentTime, 80, 'Release commits the last target');
  assert.equal(commits, 1);
  assert.equal(p.video.paused, false);
  assert.equal(p.replay.followLive, false);
  p.slider.dispatchEvent(new Event('change'));
  p.window.dispatchEvent(event('pointerup', { pointerId: 1 }));
  assert.equal(commits, 1, 'A trailing native change/up must not seek twice');
});

test('held keyboard input previews through native change events and commits once on keyup', async () => {
  const p = await player();
  p.video.pause();
  let commits = 0;
  p.window.addEventListener('replaypositionchange', () => commits++);
  for (let target = 97; target >= 50; target--) {
    p.slider.dispatchEvent(event('keydown', { key: 'ArrowLeft', repeat: target < 97 }));
    input(p, target);
    p.slider.dispatchEvent(new Event('change'));
  }
  assert.equal(commits, 0);
  close(p.video.currentTime, 98, 'Held keys must not seek');
  p.window.dispatchEvent(event('keyup', { key: 'ArrowLeft' }));
  assert.equal(commits, 1);
  close(p.video.currentTime, 50, 'Key release commits once');
  assert.equal(p.video.paused, true);
});

test('wheel and trackpad events accumulate previews and commit only after scrolling stops', async () => {
  const p = await player();
  let commits = 0;
  p.window.addEventListener('replaypositionchange', () => commits++);
  for (let index = 0; index < 12; index++) {
    const wheel = event('wheel', { deltaX: -10, deltaY: 0, deltaMode: 0 });
    p.slider.dispatchEvent(wheel);
    assert.equal(wheel.defaultPrevented, true);
    p.elapse(100);
    close(p.video.currentTime, 98, 'Scrolling must not seek');
  }
  close(p.replay.previewPosition, 70, 'Horizontal pixels map through the fixed timeline span');
  assert.equal(commits, 0);
  p.elapse(149);
  assert.equal(commits, 0);
  p.elapse(1);
  assert.equal(commits, 1);
  close(p.video.currentTime, 70, 'Idle commits the final scroll position');
  assert.equal(p.replay.scrubbing, false);
});

test('vertical mouse wheels support line units and browser zoom is left alone', async () => {
  const p = await player();
  const zoom = event('wheel', { deltaX: 0, deltaY: -1, deltaMode: 1, ctrlKey: true });
  p.slider.dispatchEvent(zoom);
  assert.equal(zoom.defaultPrevented, false);
  assert.equal(p.replay.scrubbing, false);
  p.slider.dispatchEvent(event('wheel', { deltaX: 0, deltaY: -1, deltaMode: 1 }));
  close(p.replay.previewPosition, 96, 'One line scrolls sixteen pixels');
  p.elapse(250);
  close(p.video.currentTime, 96, 'The wheel commits after settling');
});

test('cancelled touch, Escape, window blur, offline, and page closure discard pending seeks', async () => {
  for (const action of ['pointercancel', 'Escape', 'blur', 'resize', 'offline', 'close']) {
    const p = await player();
    p.slider.dispatchEvent(event('pointerdown', { pointerId: 1, button: 0 }));
    input(p, 20);
    if (action === 'Escape') p.slider.dispatchEvent(event('keydown', { key: 'Escape' }));
    else if (action === 'close') { p.replay.release = () => {}; p.replay.close(); }
    else p.window.dispatchEvent(new Event(action));
    p.window.dispatchEvent(event('pointerup', { pointerId: 1 }));
    p.elapse(1000);
    close(p.video.currentTime, 98, `${action} must not commit`);
    assert.equal(p.replay.scrubbing, false);
  }
});

test('a cancelled scroll timer cannot seek another page session', async () => {
  const p = await player();
  p.slider.dispatchEvent(event('wheel', { deltaX: -100, deltaY: 0, deltaMode: 0 }));
  const previous = p.replay.session;
  p.replay.release = () => {};
  p.replay.close();
  p.replay.session = { ...previous, camera_id: 'other', end_seconds: 2 };
  p.video.currentTime = 0;
  p.elapse(1000);
  close(p.video.currentTime, 0, 'A stale scroll must not seek the replacement session');
  assert.equal(p.timers.size, 0);
});

test('a second finger cannot end a primary drag and a cancelled gesture preserves pause', async () => {
  const p = await player();
  p.video.pause();
  p.slider.dispatchEvent(event('pointerdown', { pointerId: 1, button: 0 }));
  input(p, 30);
  p.slider.dispatchEvent(event('pointerdown', { pointerId: 2, button: 0, isPrimary: false }));
  p.window.dispatchEvent(event('pointerup', { pointerId: 2 }));
  close(p.video.currentTime, 98, 'Another finger must not commit');
  p.window.dispatchEvent(new Event('pointercancel'));
  assert.equal(p.video.paused, true);
  close(p.video.currentTime, 98, 'Cancellation keeps the paused frame');
});

test('JPEG drags leave the full-size frame alone until release', async () => {
  const p = await player({ kind: 'jpeg' });
  p.replay.togglePause();
  const pausedAt = p.replay.position;
  p.replay.image.src = '/live.jpg';
  p.slider.dispatchEvent(new Event('pointerdown'));
  for (const target of [40, 20, 70, 30]) input(p, target);
  assert.equal(p.replay.image.src, '/live.jpg');
  close(p.replay.position, pausedAt, 'Printer stats still follow the displayed image');
  p.window.dispatchEvent(new Event('pointerup'));
  assert.equal(p.replay.image.src, '/fixture.jpg?at=30');
  close(p.replay.position, 30, 'The released frame becomes the displayed time');
});

test('pressing and releasing the existing thumb without input does not seek', async () => {
  const p = await player();
  let commits = 0;
  p.window.addEventListener('replaypositionchange', () => commits++);
  p.slider.dispatchEvent(new Event('pointerdown'));
  p.window.dispatchEvent(new Event('pointerup'));
  close(p.video.currentTime, 98, 'Touching the thumb alone must not jump to the Live edge');
  assert.equal(commits, 0);
});

test('Escape discards subsequent native drag inputs until that pointer is released', async () => {
  const p = await player();
  p.slider.dispatchEvent(event('pointerdown', { pointerId: 1, button: 0 }));
  input(p, 30);
  p.window.dispatchEvent(event('keydown', { key: 'Escape' }));
  input(p, 50);
  input(p, 70);
  close(p.video.currentTime, 98, 'An abandoned drag must not become immediate seeks');
  p.window.dispatchEvent(event('pointerup', { pointerId: 1 }));
  input(p, 20);
  close(p.video.currentTime, 20, 'A later assistive input remains usable');
});

test('a browser-cancelled pointer does not block subsequent assistive input', async () => {
  const p = await player();
  p.slider.dispatchEvent(event('pointerdown', { pointerId: 1, button: 0 }));
  input(p, 30);
  p.window.dispatchEvent(new Event('pointercancel'));
  close(p.video.currentTime, 98, 'Cancellation does not commit the drag');
  input(p, 20);
  close(p.video.currentTime, 20, 'Assistive input works without a later pointerup');
});

test('a reported stream error stops predicting new live footage', async () => {
  const p = await player();
  p.replay.togglePause();
  p.replay.session.error = 'Camera disconnected';
  const offset = p.document.getElementById('replay-time').textContent;
  for (let second = 0; second < 30; second++) p.advance(1, 0);
  assert.equal(p.document.getElementById('replay-time').textContent, offset);
});

test('unreported missing segments cap the display prediction rather than growing forever', async () => {
  const p = await player();
  p.replay.togglePause();
  for (let second = 0; second < 30; second++) p.advance(1, 0);
  assert.equal(p.document.getElementById('replay-time').textContent, '−0:08');
});

test('finite files interpolate before EOF but never display footage beyond their duration', async () => {
  const p = await player({ kind: 'file', end: 99, current: 95, duration: 100 });
  p.replay.seek(95);
  p.advance(0.5, 0, 0.5);
  close(p.replay.timeline.edge, 99.5, 'The finite file still interpolates its growing live edge');
  for (let tick = 0; tick < 8; tick++) {
    p.advance(0.25, 0, 0.25);
    assert(p.replay.timeline.edge <= 100);
    assert(Number(p.slider.max) <= 100);
  }
  p.replay.session.end_seconds = 100;
  p.video.currentTime = 100;
  p.video.pause();
  for (let second = 0; second < 30; second++) p.advance(1, 0, 0);
  close(p.replay.timeline.edge, 100, 'EOF stops the display clock');
  close(Number(p.slider.max), 100, 'EOF bounds the paused timeline');
  assert.equal(p.document.getElementById('replay-time').hidden, true, 'A final frame has no invented delay from Live');
});

test('finite-file replay keeps its live-relative fraction while playback and recording advance', async () => {
  const p = await player({ kind: 'file', duration: 300 });
  p.replay.seek(50);
  const fraction = p.fraction();
  for (let second = 0; second < 120; second++) {
    p.advance();
    close(p.fraction(), fraction, 'Matched-rate native file replay');
  }
});

test('late file metadata also clamps an existing paused display estimate', async () => {
  const p = await player({ kind: 'file', current: 100 });
  p.video.pause();
  p.advance(6, 0, 0);
  close(p.replay.timeline.edge, 106, 'Duration is not known yet');
  p.video.duration = 100;
  p.replay.render();
  close(p.replay.timeline.edge, 100, 'Known duration corrects the prediction');
  close(Number(p.slider.max), 100, 'Known duration corrects the frozen window');
});

test('closing a page session resets the live clock and view for the next session', async () => {
  const p = await player();
  p.replay.seek(50);
  for (let second = 0; second < 30; second++) p.advance();
  const previous = p.replay.session;
  p.replay.release = () => {};
  p.replay.close();
  p.replay.session = { ...previous, start_seconds: 0, end_seconds: 2 };
  p.video.currentTime = 0;
  p.replay.render();
  assert.deepEqual(p.snapshot(), { min: 0, max: 2, value: 2 });
});
