import { testDouble, untrustedInput } from './test-doubles.ts';
import type { PageReplay } from '../src/replay.js';
import type { TelemetryWindow } from '../../backend-contracts/src/index.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { PrinterHistory, printerPlaybackTime } from '../src/printer-history.js';
import type { TestContext } from 'node:test';

const session = { session_id: 'a'.repeat(32), camera_id: 'b'.repeat(16) };
const payload = (
  samples: ReadonlyArray<readonly [number, number]>,
  from: number,
  until: number,
  extra = {},
) => ({
  ...session,
  from,
  until,
  samples: samples.map(([at, layer]) => ({ at, printer: { layer, progress: layer, nozzle: 200 + layer } })),
  ...extra,
});
const quiet = () =>
  new PrinterHistory(() => {}, {
    fetcher: () => {
      throw new Error('Unexpected history fetch');
    },
  });
const settled = () => new Promise((resolve) => setImmediate(resolve));

function deferredHistory(t: TestContext, { onChange = () => {}, maxWindows = 8, abortAware = false } = {}) {
  const requests: Array<{
    url: string;
    signal: AbortSignal | null | undefined;
    resolve: (value: Response | PromiseLike<Response>) => void;
    reject: (reason?: unknown) => void;
  }> = [];
  const history = new PrinterHistory(onChange, {
    maxWindows,
    fetcher: (url, init) =>
      new Promise((resolve, reject) => {
        requests.push({ url, signal: init!.signal, resolve, reject });
        if (abortAware)
          init!.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
            once: true,
          });
      }),
  });
  history.setSession(testDouble<Parameters<typeof history.setSession>[0]>(session));
  t.after(async () => {
    history.setSession(null);
    for (const request of requests) request.reject(new DOMException('Fixture finished', 'AbortError'));
    await settled();
  });
  return {
    history,
    requests,
    respond(index: number, body: unknown) {
      requests[index]!.resolve(testDouble<Response>({ ok: true, json: async () => body }));
    },
  };
}

test('printer readings follow the playhead and stay fixed while new live reports arrive', () => {
  const history = quiet();
  history.setSession(testDouble<Parameters<typeof history.setSession>[0]>(session));
  history.apply(
    payload(
      [
        [100, 1],
        [102, 2],
        [104, 3],
      ],
      100,
      104,
    ),
  );
  assert.equal(history.read(101)!.layer, 1);
  history.apply(
    payload(
      [
        [104, 3],
        [106, 4],
      ],
      104,
      106,
    ),
  );
  assert.equal(history.read(101)!.layer, 1);
  assert.equal(history.read(105)!.layer, 3);
  assert.equal(history.read(106)!.layer, 4);
});

test('debug export peeks at cached readings without creating windows or starting requests', () => {
  const history = quiet();
  history.setSession(testDouble<Parameters<typeof history.setSession>[0]>(session));
  assert.equal(history.peek(101), null);
  assert.equal(history.windows.size, 0);
  history.apply(
    payload(
      [
        [100, 1],
        [102, 2],
      ],
      100,
      104,
    ),
  );
  assert.equal(history.peek(101)!.layer, 1);
  assert.equal(history.peek(105), null);
  assert.equal(history.peek(NaN), null);
  assert.equal(history.windows.size, 1);
});

test('readings are never interpolated or taken from the future; zero remains valid', () => {
  const history = quiet();
  history.setSession(testDouble<Parameters<typeof history.setSession>[0]>(session));
  history.apply(
    payload(
      [
        [102, 0],
        [104, 10],
      ],
      100,
      106,
    ),
  );
  assert.equal(history.read(101), null);
  assert.equal(history.read(102)!.progress, 0);
  assert.equal(history.read(103.99)!.layer, 0);
  assert.equal(history.read(104)!.layer, 10);
});

test('a distant seek fetches one window; rendering and new live data do not cause polling', async () => {
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  const history = new PrinterHistory(() => {}, {
    fetcher: async (url, init) => {
      requests.push({ url, init });
      return testDouble<Response>({ ok: true, json: async () => payload([[101, 4]], 0, 119.99) });
    },
  });
  history.setSession(testDouble<Parameters<typeof history.setSession>[0]>(session));
  assert.equal(history.read(103), null);
  await new Promise((resolve) => setImmediate(resolve));
  for (let at = 103; at < 110; at++) assert.equal(history.read(at)!.layer, 4);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.init!.cache, 'no-store');
  assert.match(requests[0]!.url, /\/printer\?at=103$/);
});

test('camera/session changes abort old fetches and reject late history and SSE packets', async () => {
  const pending: Array<{
    init: RequestInit | undefined;
    resolve: (value: Response | PromiseLike<Response>) => void;
  }> = [];
  const history = new PrinterHistory(() => {}, {
    fetcher: (url, init) => new Promise((resolve) => pending.push({ init, resolve })),
  });
  history.setSession(testDouble<Parameters<typeof history.setSession>[0]>(session));
  history.read(103);
  history.setSession(
    testDouble<Parameters<typeof history.setSession>[0]>({
      session_id: 'c'.repeat(32),
      camera_id: 'd'.repeat(16),
    }),
  );
  assert.equal(pending[0]!.init!.signal!.aborted, true);
  pending[0]!.resolve(testDouble<Response>({ ok: true, json: async () => payload([[101, 4]], 0, 120) }));
  await new Promise((resolve) => setImmediate(resolve));
  history.apply(payload([[101, 4]], 0, 120));
  assert.equal(history.windows.size, 0);
});

test('a history outage does not cause polling; explicit retry can recover', async (t) => {
  t.mock.method(console, 'warn', () => {});
  let requests = 0;
  const history = new PrinterHistory(() => {}, {
    fetcher: async () => {
      requests++;
      if (requests === 1) throw new Error('Unavailable');
      return testDouble<Response>({ ok: true, json: async () => payload([[101, 7]], 0, 120) });
    },
  });
  history.setSession(testDouble<Parameters<typeof history.setSession>[0]>(session));
  history.read(103);
  await new Promise((resolve) => setImmediate(resolve));
  for (let frame = 0; frame < 60; frame++) assert.equal(history.read(103 + frame / 10), null);
  assert.equal(requests, 1);
  history.retry();
  history.read(103);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(history.read(103)!.layer, 7);
  assert.equal(requests, 2);
});

test('a superseded window can load again without an explicit retry and pending reads still coalesce', async (t) => {
  const { history, requests, respond } = deferredHistory(t, { maxWindows: 2, abortAware: true });
  history.read(103);
  history.read(130);
  assert.equal(requests[0]!.signal!.aborted, true);
  respond(1, payload([[125, 2]], 120, 239));
  await settled();
  assert.equal(history.read(130)!.layer, 2);
  assert.equal(history.read(103), null);
  assert.equal(
    requests.length,
    3,
    'Returning to a canceled window must not require a sender seek or online event.',
  );
  for (let frame = 0; frame < 60; frame++) assert.equal(history.read(103), null);
  assert.equal(requests.length, 3);
  respond(2, payload([[101, 7]], 0, 119));
  await settled();
  assert.equal(history.read(103)!.layer, 7);
  assert(history.windows.size <= 2);
});

test('late canceled success or abort cannot release a newer request for the same window', async (t) => {
  for (const outcome of ['success', 'abort'])
    await t.test(outcome, async (t) => {
      const { history, requests, respond } = deferredHistory(t);
      history.read(103);
      history.read(130);
      history.read(103);
      assert.equal(
        requests.length,
        3,
        'Canceled requests need not settle before a later read can return to their window.',
      );
      const currentSignal = requests[2]!.signal;
      if (outcome === 'success') respond(0, payload([[101, 1]], 0, 119));
      else requests[0]!.reject(new DOMException('Late abort', 'AbortError'));
      respond(1, payload([[125, 2]], 120, 239));
      await settled();
      assert.equal(history.peek(103), null, 'Late canceled readings must not become current.');
      assert.equal(history.pending, 0);
      assert.equal(history.controller!.signal, currentSignal);
      assert.equal(history.windows.get(0)!.requested, true);
      for (let frame = 0; frame < 60; frame++) history.read(103);
      assert.equal(requests.length, 3);
      respond(2, payload([[101, 7]], 0, 119));
      await settled();
      assert.equal(history.read(103)!.layer, 7);
    });
});

test('explicit retry still coalesces reads while the current window request is pending', async (t) => {
  const { history, requests, respond } = deferredHistory(t);
  history.read(103);
  history.retry();
  for (let frame = 0; frame < 60; frame++) history.read(103);
  assert.equal(requests.length, 1);
  respond(0, payload([[101, 7]], 0, 119));
  await settled();
  assert.equal(history.read(103)!.layer, 7);
});

test('late cancellation cannot reset a replacement session at the same window', async (t) => {
  const { history, requests, respond } = deferredHistory(t);
  const replacement = { session_id: 'c'.repeat(32), camera_id: 'd'.repeat(16) };
  history.read(103);
  history.setSession(testDouble<Parameters<typeof history.setSession>[0]>(replacement));
  history.read(103);
  assert.equal(requests[0]!.signal!.aborted, true);
  const currentSignal = requests[1]!.signal;
  respond(0, payload([[101, 1]], 0, 119));
  await settled();
  assert.equal(history.peek(103), null);
  assert.equal(history.pending, 0);
  assert.equal(history.controller!.signal, currentSignal);
  assert.equal(history.windows.get(0)!.requested, true);
  for (let frame = 0; frame < 60; frame++) history.read(103);
  assert.equal(requests.length, 2);
  respond(1, payload([[101, 7]], 0, 119, replacement));
  await settled();
  assert.equal(history.read(103)!.layer, 7);
});

test('an explicitly aborted unfinished request releases only its own suppression', async (t) => {
  const { history, requests, respond } = deferredHistory(t, { abortAware: true });
  history.read(103);
  history.controller!.abort();
  await settled();
  assert.equal(history.pending, null);
  history.read(103);
  assert.equal(requests.length, 2);
  respond(1, payload([[101, 7]], 0, 119));
  await settled();
  assert.equal(history.read(103)!.layer, 7);
});

test('completed windows stay suppressed when their notification starts another read', async (t) => {
  const fixture: ReturnType<typeof deferredHistory> = deferredHistory(t, {
    onChange: () => fixture.history.read(130),
  });
  const { history } = fixture;
  history.read(103);
  fixture.respond(0, payload([[101, 7]], 100, 105));
  await settled();
  assert.equal(fixture.requests.length, 2);
  assert.equal(history.windows.get(0)!.requested, true);
  history.read(110);
  assert.equal(fixture.requests.length, 2, 'A successful partial window is not an unfinished cancellation.');
  fixture.respond(1, payload([[125, 2]], 120, 239));
  await settled();
});

test('later recorded coverage hydrates a successful partial window once and cached readings remain stable', async (t) => {
  const { history, requests, respond } = deferredHistory(t, { maxWindows: 3 });
  history.read(1220);
  respond(
    0,
    payload(
      [
        [1220, 20],
        [1262, 62],
      ],
      1200,
      1262,
    ),
  );
  await settled();
  assert.equal(history.read(1220)!.layer, 20);
  for (let frame = 0; frame < 60; frame++) assert.equal(history.read(1280), null);
  assert.equal(
    requests.length,
    1,
    'A future point and unchanged coverage must not refetch a partial success.',
  );
  history.apply(
    payload(
      [
        [1339, 39],
        [1370, 70],
      ],
      1339,
      1370,
    ),
  );
  assert.equal(history.read(1280), null);
  const current = requests[1]!.signal;
  for (let frame = 0; frame < 60; frame++) history.read(1280);
  assert.equal(requests.length, 2);
  assert.equal(history.controller!.signal, current);
  respond(
    1,
    payload(
      [
        [1220, 20],
        [1280, 80],
        [1290, 90],
      ],
      1200,
      1320,
    ),
  );
  await settled();
  assert.equal(history.read(1280)!.layer, 80);
  assert.equal(history.read(1220)!.layer, 20);
  for (let frame = 0; frame < 60; frame++) {
    history.apply(payload([[1370, 70]], 1339, 1370));
    assert.equal(history.read(1290)!.layer, 90);
  }
  assert.equal(
    requests.length,
    2,
    'A completed full window stays cached after repeated SSE and render reads.',
  );
  assert(history.windows.size <= 3);
});

test('invalid, other-session and future query envelopes cannot authorize partial hydration', async (t) => {
  const { history, requests, respond } = deferredHistory(t);
  history.read(1220);
  respond(
    0,
    payload(
      [
        [1220, 20],
        [1262, 62],
      ],
      1200,
      1262,
    ),
  );
  await settled();
  for (const packet of [
    payload([[1370, 70]], 1339, 1370, { session_id: 'c'.repeat(32) }),
    payload([[1370, 70]], 1339, 1370, { camera_id: 'd'.repeat(16) }),
    payload([[1370, 70]], 1339, NaN),
    payload([[1370, 70]], 1370, 1339),
    payload([], 1320, 1440),
    payload([[1262, 62]], 1320, 1440), // Future query with an older baseline.
    payload([[2000, 1]], 1339, 1370), // Sample outside the accepted coverage.
    {
      ...session,
      from: 1339,
      until: 1370,
      samples: [null, { at: 1370, printer: null }, { at: NaN, printer: {} }],
    },
  ]) {
    history.apply(untrustedInput<TelemetryWindow>(packet));
    for (let frame = 0; frame < 5; frame++) assert.equal(history.read(1280), null);
    assert.equal(requests.length, 1);
  }
  history.apply(payload([[1370, 70]], 1339, 1370));
  history.read(1280);
  assert.equal(requests.length, 2, 'An actual accepted later sample supplies the missing evidence.');
  respond(1, payload([[1280, 80]], 1200, 1320));
  await settled();
  assert.equal(history.read(1280)!.layer, 80);
});

test('recording that advances during a partial request remains evidence after its response', async (t) => {
  const { history, requests, respond } = deferredHistory(t);
  history.apply(payload([[1262, 62]], 1231, 1262));
  history.read(1220);
  history.apply(payload([[1370, 70]], 1339, 1370));
  respond(
    0,
    payload(
      [
        [1220, 20],
        [1262, 62],
      ],
      1200,
      1262,
    ),
  );
  await settled();
  history.read(1280);
  assert.equal(
    requests.length,
    2,
    'The in-flight response must not erase newer accepted recording evidence.',
  );
  respond(1, payload([[1280, 80]], 1200, 1320));
  await settled();
  assert.equal(history.read(1280)!.layer, 80);
});

test('an identical partial hydration is consumed rather than retried by rendering or advancing SSE', async (t) => {
  const fixture: ReturnType<typeof deferredHistory> = deferredHistory(t, {
    onChange: () => fixture.history.read(1280),
  });
  const { history } = fixture;
  history.read(1220);
  fixture.respond(
    0,
    payload(
      [
        [1220, 20],
        [1262, 62],
      ],
      1200,
      1262,
    ),
  );
  await settled();
  history.apply(payload([[1370, 70]], 1339, 1370));
  assert.equal(fixture.requests.length, 2);
  fixture.respond(
    1,
    payload(
      [
        [1220, 20],
        [1262, 62],
      ],
      1200,
      1262,
    ),
  );
  await settled();
  for (let second = 1371; second < 1400; second++) {
    history.apply(payload([[second, second % 100]], second - 1, second));
    for (let frame = 0; frame < 5; frame++) assert.equal(history.read(1280), null);
  }
  assert.equal(
    fixture.requests.length,
    2,
    'Success with the same incomplete coverage must not become an SSE polling loop.',
  );
  assert.equal(history.read(1220)!.layer, 20);
  history.retry();
  history.read(1280);
  assert.equal(fixture.requests.length, 3);
  fixture.respond(2, payload([[1280, 80]], 1200, 1320));
  await settled();
  assert.equal(history.read(1280)!.layer, 80);
});

test('a hydration covering its target may recover a later recorded portion without fetching future points', async (t) => {
  const { history, requests, respond } = deferredHistory(t);
  history.read(1220);
  respond(
    0,
    payload(
      [
        [1220, 20],
        [1230, 30],
      ],
      1200,
      1230,
    ),
  );
  await settled();
  history.apply(payload([[1260, 60]], 1255, 1260));
  history.read(1240);
  respond(
    1,
    payload(
      [
        [1240, 40],
        [1250, 50],
      ],
      1200,
      1250,
    ),
  );
  await settled();
  assert.equal(history.read(1240)!.layer, 40);
  for (let frame = 0; frame < 60; frame++) assert.equal(history.read(1270), null);
  assert.equal(requests.length, 2);
  history.apply(payload([[1300, 100]], 1299, 1300));
  history.read(1270);
  assert.equal(requests.length, 3);
  respond(2, payload([[1270, 70]], 1200, 1320));
  await settled();
  assert.equal(history.read(1270)!.layer, 70);
});

test('an initially unrecorded query can hydrate only after actual later recording, including an empty partial', async (t) => {
  for (const body of [payload([[1262, 62]], 1200, 1262), payload([], 1200, 1200)])
    await t.test(String(body.until), async (t) => {
      const { history, requests, respond } = deferredHistory(t);
      history.read(1280);
      respond(0, body);
      await settled();
      for (let frame = 0; frame < 60; frame++) assert.equal(history.read(1280), null);
      assert.equal(requests.length, 1);
      history.apply(payload([[1370, 70]], 1339, 1370));
      history.read(1280);
      assert.equal(requests.length, 2);
      respond(1, payload([[1280, 80]], 1200, 1320));
      await settled();
      assert.equal(history.read(1280)!.layer, 80);
    });
});

test('canceling a hydration preserves P23 return-to-window and late-callback ownership', async (t) => {
  const { history, requests, respond } = deferredHistory(t);
  history.read(1220);
  respond(
    0,
    payload(
      [
        [1220, 20],
        [1262, 62],
      ],
      1200,
      1262,
    ),
  );
  await settled();
  history.apply(payload([[1370, 70]], 1339, 1370));
  history.read(1280);
  history.read(1460);
  history.read(1280);
  assert.equal(requests.length, 4);
  assert.equal(requests[1]!.signal!.aborted, true);
  const current = requests[3]!.signal;
  respond(1, payload([[1280, 1]], 1200, 1320));
  respond(2, payload([[1460, 2]], 1440, 1560));
  await settled();
  assert.equal(history.peek(1280), null);
  assert.equal(history.pending, 10);
  assert.equal(history.controller!.signal, current);
  for (let frame = 0; frame < 60; frame++) history.read(1280);
  assert.equal(requests.length, 4);
  respond(3, payload([[1280, 80]], 1200, 1320));
  await settled();
  assert.equal(history.read(1280)!.layer, 80);
});

test('replacement sessions reject old recorded coverage and late hydration responses', async (t) => {
  const { history, requests, respond } = deferredHistory(t);
  history.read(1220);
  respond(
    0,
    payload(
      [
        [1220, 20],
        [1262, 62],
      ],
      1200,
      1262,
    ),
  );
  await settled();
  history.apply(payload([[1370, 70]], 1339, 1370));
  history.read(1280);
  const replacement = { session_id: 'c'.repeat(32), camera_id: 'd'.repeat(16) };
  history.setSession(testDouble<Parameters<typeof history.setSession>[0]>(replacement));
  history.read(1220);
  respond(
    2,
    payload(
      [
        [1220, 3],
        [1262, 4],
      ],
      1200,
      1262,
      replacement,
    ),
  );
  await settled();
  respond(1, payload([[1280, 80]], 1200, 1320));
  history.apply(payload([[1400, 100]], 1390, 1400));
  await settled();
  for (let frame = 0; frame < 60; frame++) assert.equal(history.read(1280), null);
  assert.equal(
    requests.length,
    3,
    'Previous session watermarks or callbacks must not authorize new-session requests.',
  );
  history.apply(payload([[1370, 70]], 1339, 1370, replacement));
  history.read(1280);
  assert.equal(requests.length, 4);
  respond(3, payload([[1280, 8]], 1200, 1320, replacement));
  await settled();
  assert.equal(history.read(1280)!.layer, 8);
});

test('real HTTP, JSON and timeout failures stay sticky while recorded SSE advances', async (t) => {
  t.mock.method(console, 'warn', () => {});
  for (const stage of ['initial', 'hydration'])
    for (const failure of ['HTTP', 'JSON', 'timeout'])
      await t.test(`${stage} ${failure}`, async (t) => {
        const { history, requests, respond } = deferredHistory(t, { abortAware: true });
        if (stage === 'hydration') {
          history.read(1220);
          respond(
            0,
            payload(
              [
                [1220, 20],
                [1262, 62],
              ],
              1200,
              1262,
            ),
          );
          await settled();
          history.apply(payload([[1370, 70]], 1339, 1370));
        }
        if (failure === 'timeout') t.mock.timers.enable({ apis: ['setTimeout'] });
        const time = stage === 'hydration' ? 1280 : 1220;
        history.read(time);
        assert.equal(
          requests.length,
          stage === 'hydration' ? 2 : 1,
          'The request receiving the injected failure must be active.',
        );
        const failed = requests.length - 1;
        if (failure === 'timeout') t.mock.timers.tick(6000);
        else
          requests[failed]!.resolve(
            failure === 'HTTP'
              ? testDouble<Response>({ ok: false })
              : testDouble<Response>({
                  ok: true,
                  json: async () => {
                    throw new SyntaxError('Synthetic invalid JSON');
                  },
                }),
          );
        await settled();
        for (let second = 1370; second < 1400; second++) {
          history.apply(payload([[second, second % 100]], second - 1, second));
          assert.equal(history.read(time), null);
          assert.equal(history.read(1280), null);
        }
        assert.equal(requests.length, failed + 1);
        history.retry();
        history.read(time);
        assert.equal(requests.length, failed + 2);
        respond(failed + 1, payload([[time, 20]], 1200, 1320));
        await settled();
        assert.equal(history.read(time)!.layer, 20);
      });
});

test('HTTP and JSON failures stay suppressed across other reads until explicit retry', async (t) => {
  t.mock.method(console, 'warn', () => {});
  for (const failure of [
    testDouble<Response>({ ok: false }),
    testDouble<Response>({
      ok: true,
      json: async () => {
        throw new SyntaxError('Synthetic malformed response');
      },
    }),
  ])
    await t.test(failure.ok ? 'invalid JSON' : 'HTTP failure', async (t) => {
      const { history, requests, respond } = deferredHistory(t);
      history.read(103);
      requests[0]!.resolve(failure);
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
      assert.equal(history.read(103)!.layer, 7);
    });
});

test('timeouts remain suppressed when a slow aborted fetch settles after a newer request', async (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { history, requests, respond } = deferredHistory(t);
  history.read(103);
  t.mock.timers.tick(6000);
  assert.equal(requests[0]!.signal!.aborted, true);
  history.read(130);
  respond(1, payload([[125, 2]], 120, 239));
  await settled();
  for (let frame = 0; frame < 60; frame++) assert.equal(history.read(103), null);
  assert.equal(
    requests.length,
    2,
    'Superseding a timed-out request must not turn render reads into retries.',
  );
  history.retry();
  history.read(103);
  assert.equal(requests.length, 3);
  const currentSignal = requests[2]!.signal;
  respond(0, payload([[101, 1]], 0, 119));
  await settled();
  assert.equal(history.pending, 0);
  assert.equal(history.controller!.signal, currentSignal);
  assert.equal(history.peek(103), null);
  respond(2, payload([[101, 7]], 0, 119));
  await settled();
  assert.equal(history.read(103)!.layer, 7);
});

test('a reconnect gap can be hydrated without changing the paused reading', async () => {
  let requests = 0;
  const history = new PrinterHistory(() => {}, {
    fetcher: async () => {
      requests++;
      return testDouble<Response>({
        ok: true,
        json: async () =>
          payload(
            [
              [125, 2],
              [150, 3],
            ],
            120,
            210,
          ),
      });
    },
  });
  history.setSession(testDouble<Parameters<typeof history.setSession>[0]>(session));
  history.apply(payload([[100, 1]], 100, 110));
  history.apply(payload([[200, 8]], 200, 210));
  assert.equal(history.read(105)!.layer, 1);
  assert.equal(history.read(150), null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(history.read(150)!.layer, 3);
  assert.equal(history.read(105)!.layer, 1);
  assert.equal(requests, 1);
});

test('bounded windows keep the selected past while recent data is added', () => {
  const history = new PrinterHistory(() => {}, { maxWindows: 3 });
  history.setSession(testDouble<Parameters<typeof history.setSession>[0]>(session));
  for (let window = 0; window < 8; window++) {
    if (window > 0) assert.equal(history.read(1)!.layer, 0);
    history.apply(payload([[window * 120, window]], window * 120, window * 120 + 119));
    assert(history.windows.size <= 3);
  }
  assert.equal(history.read(1)!.layer, 0);
});

test('gaps remain unknown until a window is fetched and samples span bucket boundaries', () => {
  const history = quiet();
  history.setSession(testDouble<Parameters<typeof history.setSession>[0]>(session));
  history.apply(
    payload(
      [
        [118, 1],
        [121, 2],
      ],
      118,
      122,
    ),
  );
  assert.equal(history.read(120)!.layer, 1);
  assert.equal(history.read(121)!.layer, 2);
  history.apply(payload([[150, 3]], 150, 151));
  assert.equal(history.read(120)!.layer, 1);
  assert.equal(history.read(150)!.layer, 3);
});

test('media program dates are used in preference to page time and native HLS has a clock fallback', () => {
  const replay = testDouble<PageReplay>({
    session: {
      clock: [
        { position: 0, time: 1000 },
        { position: 20, time: 2000 },
      ],
    },
    paused: false,
    bounds: () => ({ current: 25 }),
  });
  assert.equal(
    printerPlaybackTime(
      testDouble<Parameters<typeof printerPlaybackTime>[0]>({ currentTime: 25 }),
      testDouble<Parameters<typeof printerPlaybackTime>[1]>({ playingDate: new Date(3000000) }),
      replay,
    ),
    3000,
  );
  assert.equal(
    printerPlaybackTime(
      testDouble<Parameters<typeof printerPlaybackTime>[0]>({
        currentTime: 25,
        getStartDate: () => new Date(1000000),
      }),
      null,
      testDouble<Parameters<typeof printerPlaybackTime>[2]>(replay),
    ),
    1025,
  );
  assert.equal(
    printerPlaybackTime(
      testDouble<Parameters<typeof printerPlaybackTime>[0]>({ currentTime: 25 }),
      null,
      testDouble<Parameters<typeof printerPlaybackTime>[2]>(replay),
    ),
    2005,
  );
  replay.paused = true;
  replay.position = 10;
  assert.equal(
    printerPlaybackTime(
      testDouble<Parameters<typeof printerPlaybackTime>[0]>({}),
      null,
      testDouble<Parameters<typeof printerPlaybackTime>[2]>(replay),
    ),
    1010,
  );
  replay.session!.kind = 'jpeg';
  replay.session!.end_time = 1008;
  assert.equal(
    printerPlaybackTime(
      testDouble<Parameters<typeof printerPlaybackTime>[0]>({}),
      null,
      testDouble<Parameters<typeof printerPlaybackTime>[2]>(replay),
    ),
    null,
    'Metadata alone does not prove which JPEG decoded',
  );
  replay.jpegClock = () => 1007.125678;
  assert.equal(
    printerPlaybackTime(
      testDouble<Parameters<typeof printerPlaybackTime>[0]>({}),
      null,
      testDouble<Parameters<typeof printerPlaybackTime>[2]>(replay),
    ),
    1007.125678,
  );
  replay.session!.end_time = 1012;
  assert.equal(
    printerPlaybackTime(
      testDouble<Parameters<typeof printerPlaybackTime>[0]>({}),
      null,
      testDouble<Parameters<typeof printerPlaybackTime>[2]>(replay),
    ),
    1007.125678,
    'New capture metadata cannot advance a paused image clock',
  );
});

test('cast printer stats follow the receiver clock instead of the paused local decoder', () => {
  const replay = testDouble<PageReplay>({
    remote: {},
    session: { clock: [{ position: 0, time: 1000 }] },
    paused: false,
    bounds: () => ({ current: 70 }),
  });
  const video = { currentTime: 3, getStartDate: () => new Date(1000000) };
  assert.equal(
    printerPlaybackTime(
      testDouble<Parameters<typeof printerPlaybackTime>[0]>(video),
      testDouble<Parameters<typeof printerPlaybackTime>[1]>({ playingDate: new Date(1003000) }),
      replay,
    ),
    1070,
  );
  replay.paused = true;
  replay.position = 50;
  assert.equal(
    printerPlaybackTime(
      testDouble<Parameters<typeof printerPlaybackTime>[0]>(video),
      testDouble<Parameters<typeof printerPlaybackTime>[1]>({ playingDate: new Date(1003000) }),
      replay,
    ),
    1050,
  );
});
