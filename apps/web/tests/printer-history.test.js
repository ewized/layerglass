import assert from 'node:assert/strict';
import test from 'node:test';
import { PrinterHistory, printerPlaybackTime } from '../src/printer-history.js';

const session = { session_id: 'a'.repeat(32), camera_id: 'b'.repeat(16) };
const payload = (samples, from, until, extra = {}) => ({ ...session, from, until,
  samples: samples.map(([at, layer]) => ({ at, printer: { layer, progress: layer, nozzle: 200 + layer } })), ...extra });
const quiet = () => new PrinterHistory(() => {}, { fetcher: () => { throw new Error('Unexpected history fetch'); } });
const settled = () => new Promise(resolve => setImmediate(resolve));

function deferredHistory(t, { onChange = () => {}, maxWindows = 8, abortAware = false } = {}) {
  const requests = [];
  const history = new PrinterHistory(onChange, { maxWindows, fetcher: (url, init) => new Promise((resolve, reject) => {
    requests.push({ url, signal: init.signal, resolve, reject });
    if (abortAware) init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  }) });
  history.setSession(session);
  t.after(async () => {
    history.setSession(null);
    for (const request of requests) request.reject(new DOMException('Fixture finished', 'AbortError'));
    await settled();
  });
  return { history, requests, respond(index, body) {
    requests[index].resolve({ ok: true, json: async () => body });
  } };
}

test('printer readings follow the playhead and stay fixed while new live reports arrive', () => {
  const history = quiet(); history.setSession(session);
  history.apply(payload([[100, 1], [102, 2], [104, 3]], 100, 104));
  assert.equal(history.read(101).layer, 1);
  history.apply(payload([[104, 3], [106, 4]], 104, 106));
  assert.equal(history.read(101).layer, 1);
  assert.equal(history.read(105).layer, 3);
  assert.equal(history.read(106).layer, 4);
});

test('debug export peeks at cached readings without creating windows or starting requests', () => {
  const history = quiet(); history.setSession(session);
  assert.equal(history.peek(101), null);
  assert.equal(history.windows.size, 0);
  history.apply(payload([[100, 1], [102, 2]], 100, 104));
  assert.equal(history.peek(101).layer, 1);
  assert.equal(history.peek(105), null);
  assert.equal(history.peek(NaN), null);
  assert.equal(history.windows.size, 1);
});

test('readings are never interpolated or taken from the future; zero remains valid', () => {
  const history = quiet(); history.setSession(session);
  history.apply(payload([[102, 0], [104, 10]], 100, 106));
  assert.equal(history.read(101), null);
  assert.equal(history.read(102).progress, 0);
  assert.equal(history.read(103.99).layer, 0);
  assert.equal(history.read(104).layer, 10);
});

test('a distant seek fetches one window; rendering and new live data do not cause polling', async () => {
  const requests = [];
  const history = new PrinterHistory(() => {}, { fetcher: async (url, init) => {
    requests.push({ url, init });
    return { ok: true, json: async () => payload([[101, 4]], 0, 119.99) };
  } });
  history.setSession(session);
  assert.equal(history.read(103), null);
  await new Promise(resolve => setImmediate(resolve));
  for (let at = 103; at < 110; at++) assert.equal(history.read(at).layer, 4);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].init.cache, 'no-store');
  assert.match(requests[0].url, /\/printer\?at=103$/);
});

test('camera/session changes abort old fetches and reject late history and SSE packets', async () => {
  const pending = [];
  const history = new PrinterHistory(() => {}, { fetcher: (url, init) => new Promise(resolve => pending.push({ init, resolve })) });
  history.setSession(session);
  history.read(103);
  history.setSession({ session_id: 'c'.repeat(32), camera_id: 'd'.repeat(16) });
  assert.equal(pending[0].init.signal.aborted, true);
  pending[0].resolve({ ok: true, json: async () => payload([[101, 4]], 0, 120) });
  await new Promise(resolve => setImmediate(resolve));
  history.apply(payload([[101, 4]], 0, 120));
  assert.equal(history.windows.size, 0);
});

test('a history outage does not cause polling; explicit retry can recover', async t => {
  t.mock.method(console, 'warn', () => {});
  let requests = 0;
  const history = new PrinterHistory(() => {}, { fetcher: async () => {
    requests++;
    if (requests === 1) throw new Error('Unavailable');
    return { ok: true, json: async () => payload([[101, 7]], 0, 120) };
  } });
  history.setSession(session);
  history.read(103);
  await new Promise(resolve => setImmediate(resolve));
  for (let frame = 0; frame < 60; frame++) assert.equal(history.read(103 + frame / 10), null);
  assert.equal(requests, 1);
  history.retry(); history.read(103);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(history.read(103).layer, 7);
  assert.equal(requests, 2);
});

test('a superseded window can load again without an explicit retry and pending reads still coalesce', async t => {
  const { history, requests, respond } = deferredHistory(t, { maxWindows: 2, abortAware: true });
  history.read(103);
  history.read(130);
  assert.equal(requests[0].signal.aborted, true);
  respond(1, payload([[125, 2]], 120, 239));
  await settled();
  assert.equal(history.read(130).layer, 2);
  assert.equal(history.read(103), null);
  assert.equal(requests.length, 3, 'Returning to a canceled window must not require a sender seek or online event.');
  for (let frame = 0; frame < 60; frame++) assert.equal(history.read(103), null);
  assert.equal(requests.length, 3);
  respond(2, payload([[101, 7]], 0, 119));
  await settled();
  assert.equal(history.read(103).layer, 7);
  assert(history.windows.size <= 2);
});

test('late canceled success or abort cannot release a newer request for the same window', async t => {
  for (const outcome of ['success', 'abort']) await t.test(outcome, async t => {
    const { history, requests, respond } = deferredHistory(t);
    history.read(103);
    history.read(130);
    history.read(103);
    assert.equal(requests.length, 3, 'Canceled requests need not settle before a later read can return to their window.');
    const currentSignal = requests[2].signal;
    if (outcome === 'success') respond(0, payload([[101, 1]], 0, 119));
    else requests[0].reject(new DOMException('Late abort', 'AbortError'));
    respond(1, payload([[125, 2]], 120, 239));
    await settled();
    assert.equal(history.peek(103), null, 'Late canceled readings must not become current.');
    assert.equal(history.pending, 0);
    assert.equal(history.controller.signal, currentSignal);
    assert.equal(history.windows.get(0).requested, true);
    for (let frame = 0; frame < 60; frame++) history.read(103);
    assert.equal(requests.length, 3);
    respond(2, payload([[101, 7]], 0, 119));
    await settled();
    assert.equal(history.read(103).layer, 7);
  });
});

test('explicit retry still coalesces reads while the current window request is pending', async t => {
  const { history, requests, respond } = deferredHistory(t);
  history.read(103);
  history.retry();
  for (let frame = 0; frame < 60; frame++) history.read(103);
  assert.equal(requests.length, 1);
  respond(0, payload([[101, 7]], 0, 119));
  await settled();
  assert.equal(history.read(103).layer, 7);
});

test('late cancellation cannot reset a replacement session at the same window', async t => {
  const { history, requests, respond } = deferredHistory(t);
  const replacement = { session_id: 'c'.repeat(32), camera_id: 'd'.repeat(16) };
  history.read(103);
  history.setSession(replacement);
  history.read(103);
  assert.equal(requests[0].signal.aborted, true);
  const currentSignal = requests[1].signal;
  respond(0, payload([[101, 1]], 0, 119));
  await settled();
  assert.equal(history.peek(103), null);
  assert.equal(history.pending, 0);
  assert.equal(history.controller.signal, currentSignal);
  assert.equal(history.windows.get(0).requested, true);
  for (let frame = 0; frame < 60; frame++) history.read(103);
  assert.equal(requests.length, 2);
  respond(1, payload([[101, 7]], 0, 119, replacement));
  await settled();
  assert.equal(history.read(103).layer, 7);
});

test('an explicitly aborted unfinished request releases only its own suppression', async t => {
  const { history, requests, respond } = deferredHistory(t, { abortAware: true });
  history.read(103);
  history.controller.abort();
  await settled();
  assert.equal(history.pending, null);
  history.read(103);
  assert.equal(requests.length, 2);
  respond(1, payload([[101, 7]], 0, 119));
  await settled();
  assert.equal(history.read(103).layer, 7);
});

test('completed windows stay suppressed when their notification starts another read', async t => {
  let history;
  const fixture = deferredHistory(t, { onChange: () => history.read(130) });
  ({ history } = fixture);
  history.read(103);
  fixture.respond(0, payload([[101, 7]], 100, 105));
  await settled();
  assert.equal(fixture.requests.length, 2);
  assert.equal(history.windows.get(0).requested, true);
  history.read(110);
  assert.equal(fixture.requests.length, 2, 'A successful partial window is not an unfinished cancellation.');
  fixture.respond(1, payload([[125, 2]], 120, 239));
  await settled();
});

test('HTTP and JSON failures stay suppressed across other reads until explicit retry', async t => {
  t.mock.method(console, 'warn', () => {});
  for (const failure of [
    { ok: false },
    { ok: true, json: async () => { throw new SyntaxError('Synthetic malformed response'); } },
  ]) await t.test(failure.ok ? 'invalid JSON' : 'HTTP failure', async t => {
    const { history, requests, respond } = deferredHistory(t);
    history.read(103);
    requests[0].resolve(failure);
    await settled();
    history.read(130);
    respond(1, payload([[125, 2]], 120, 239));
    await settled();
    for (let frame = 0; frame < 60; frame++) assert.equal(history.read(103), null);
    assert.equal(requests.length, 2);
    history.retry();
    history.read(103);
    assert.equal(requests.length, 3);
    respond(2, payload([[101, 7]], 0, 119));
    await settled();
    assert.equal(history.read(103).layer, 7);
  });
});

test('timeouts remain suppressed when a slow aborted fetch settles after a newer request', async t => {
  t.mock.method(console, 'warn', () => {});
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { history, requests, respond } = deferredHistory(t);
  history.read(103);
  t.mock.timers.tick(6000);
  assert.equal(requests[0].signal.aborted, true);
  history.read(130);
  respond(1, payload([[125, 2]], 120, 239));
  await settled();
  for (let frame = 0; frame < 60; frame++) assert.equal(history.read(103), null);
  assert.equal(requests.length, 2, 'Superseding a timed-out request must not turn render reads into retries.');
  history.retry();
  history.read(103);
  assert.equal(requests.length, 3);
  const currentSignal = requests[2].signal;
  respond(0, payload([[101, 1]], 0, 119));
  await settled();
  assert.equal(history.pending, 0);
  assert.equal(history.controller.signal, currentSignal);
  assert.equal(history.peek(103), null);
  respond(2, payload([[101, 7]], 0, 119));
  await settled();
  assert.equal(history.read(103).layer, 7);
});

test('a reconnect gap can be hydrated without changing the paused reading', async () => {
  let requests = 0;
  const history = new PrinterHistory(() => {}, { fetcher: async () => {
    requests++;
    return { ok: true, json: async () => payload([[125, 2], [150, 3]], 120, 210) };
  } });
  history.setSession(session);
  history.apply(payload([[100, 1]], 100, 110));
  history.apply(payload([[200, 8]], 200, 210));
  assert.equal(history.read(105).layer, 1);
  assert.equal(history.read(150), null);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(history.read(150).layer, 3);
  assert.equal(history.read(105).layer, 1);
  assert.equal(requests, 1);
});

test('bounded windows keep the selected past while recent data is added', () => {
  const history = new PrinterHistory(() => {}, { maxWindows: 3 }); history.setSession(session);
  for (let window = 0; window < 8; window++) {
    if (window > 0) assert.equal(history.read(1).layer, 0);
    history.apply(payload([[window * 120, window]], window * 120, window * 120 + 119));
    assert(history.windows.size <= 3);
  }
  assert.equal(history.read(1).layer, 0);
});

test('gaps remain unknown until a window is fetched and samples span bucket boundaries', () => {
  const history = quiet(); history.setSession(session);
  history.apply(payload([[118, 1], [121, 2]], 118, 122));
  assert.equal(history.read(120).layer, 1);
  assert.equal(history.read(121).layer, 2);
  history.apply(payload([[150, 3]], 150, 151));
  assert.equal(history.read(120).layer, 1);
  assert.equal(history.read(150).layer, 3);
});

test('media program dates are used in preference to page time and native HLS has a clock fallback', () => {
  const replay = { session: { clock: [{ position: 0, time: 1000 }, { position: 20, time: 2000 }] },
    paused: false, bounds: () => ({ current: 25 }) };
  assert.equal(printerPlaybackTime({ currentTime: 25 }, { playingDate: new Date(3000000) }, replay), 3000);
  assert.equal(printerPlaybackTime({ currentTime: 25, getStartDate: () => new Date(1000000) }, null, replay), 1025);
  assert.equal(printerPlaybackTime({ currentTime: 25 }, null, replay), 2005);
  replay.paused = true; replay.position = 10;
  assert.equal(printerPlaybackTime({}, null, replay), 1010);
  replay.session.kind = 'jpeg'; replay.session.end_time = 1008;
  assert.equal(printerPlaybackTime({}, null, replay), 1008);
});

test('cast printer stats follow the receiver clock instead of the paused local decoder', () => {
  const replay = { remote: {}, session: { clock: [{ position: 0, time: 1000 }] },
    paused: false, bounds: () => ({ current: 70 }) };
  const video = { currentTime: 3, getStartDate: () => new Date(1000000) };
  assert.equal(printerPlaybackTime(video, { playingDate: new Date(1003000) }, replay), 1070);
  replay.paused = true;
  replay.position = 50;
  assert.equal(printerPlaybackTime(video, { playingDate: new Date(1003000) }, replay), 1050);
});
