import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { loadBrowserModule } from './browser-module.ts';
import type { Backend, BackendSnapshot } from '../../backend-contracts/src/index.js';
import { testDouble } from './test-doubles.ts';
import type { TestDouble } from './test-doubles.ts';

async function harness({
  supported = true,
  fetcher,
}: { supported?: boolean; fetcher?: TestDouble<Backend['fetch']> } = {}) {
  let now = 0;
  let timerId = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const connections: EventSource[] = [];
  const snapshots: Array<{ url: string; options?: RequestInit }> = [];
  const states: Array<BackendSnapshot> = [];
  let errors = 0;
  class EventSource extends EventTarget {
    declare url: string;
    declare readyState: number;
    declare closed: boolean;
    onerror = () => {};

    constructor(url: string) {
      super();
      this.url = url;
      this.readyState = 0;
      this.closed = false;
      connections.push(this);
    }
    close() {
      this.closed = true;
      this.readyState = 2;
    }
    send(kind: string, state: unknown) {
      this.dispatchEvent(new MessageEvent(kind, { data: JSON.stringify(state) }));
    }
    fail(state = 0) {
      this.readyState = state;
      this.onerror();
    }
  }
  const document = Object.assign(new EventTarget(), { hidden: false });
  const window = Object.assign(new EventTarget(), { EventSource: supported ? EventSource : undefined });
  const navigator = { onLine: true };
  const context = vm.createContext({
    document,
    window,
    navigator,
    EventSource,
    Event,
    URLSearchParams,
    AbortController,
    setTimeout(fn: () => void, delay: number) {
      const id = ++timerId;
      timers.set(id, { at: now + delay, fn });
      return id;
    },
    clearTimeout(id: number) {
      timers.delete(id);
    },
    fetch(url: string, options?: RequestInit) {
      snapshots.push({ url, options });
      return fetcher
        ? fetcher(url, options)
        : Promise.resolve(
            testDouble<Response>({ ok: true, json: async () => ({ version: 1, status: { state: 'live' } }) }),
          );
    },
  });
  const { PlayerUpdates } = await loadBrowserModule('updates.js', context);
  const updates = new PlayerUpdates(
    (state) => states.push(state),
    () => {
      errors++;
    },
  );
  const flush = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  };
  const advance = async (delay: number) => {
    const end = now + delay;
    for (;;) {
      const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at;
      timers.delete(next[0]);
      next[1].fn();
      await flush();
    }
    now = end;
    await flush();
  };
  return {
    updates,
    connections,
    snapshots,
    states,
    document,
    window,
    navigator,
    advance,
    flush,
    errors: () => errors,
  };
}

test('offline suspends SSE and polling, then reconnects the same camera/session', async () => {
  const h = await harness();
  h.updates.subscribe('a'.repeat(16), 'b'.repeat(32));
  h.navigator.onLine = false;
  h.window.dispatchEvent(new Event('offline'));
  assert.equal(h.connections[0]!.closed, true);
  await h.advance(180000);
  assert.equal(h.connections.length, 1);
  assert.equal(h.snapshots.length, 0);
  h.navigator.onLine = true;
  h.window.dispatchEvent(new Event('online'));
  assert.equal(h.connections.length, 2);
  assert.equal(h.connections[1]!.url, h.connections[0]!.url);
});

test('an offline app launch waits for network before contacting the server', async () => {
  const h = await harness();
  h.navigator.onLine = false;
  h.updates.subscribe(null);
  await h.advance(180000);
  assert.equal(h.connections.length, 0);
  assert.equal(h.snapshots.length, 0);
  h.navigator.onLine = true;
  h.window.dispatchEvent(new Event('online'));
  assert.equal(h.connections.length, 1);
});

test('one active stream per camera/session and identical subscriptions do not reconnect', async () => {
  const h = await harness();
  h.updates.subscribe('a'.repeat(16), 'b'.repeat(32));
  h.updates.subscribe('a'.repeat(16), 'b'.repeat(32));
  assert.equal(h.connections.length, 1);
  assert.equal(h.connections[0]!.url, `/api/events?camera=${'a'.repeat(16)}&session=${'b'.repeat(32)}`);
  h.updates.subscribe('c'.repeat(16));
  assert.equal(h.connections[0]!.closed, true);
  assert.equal(h.connections.length, 2);
  assert.equal(h.connections.filter((connection) => !connection.closed).length, 1);
});

test('healthy pushed state and heartbeats make no polling requests', async () => {
  const h = await harness();
  h.updates.subscribe(null);
  h.connections[0]!.send('state', { version: 1, status: { state: 'live' } });
  for (let i = 0; i < 6; i++) {
    await h.advance(15000);
    h.connections[0]!.send('heartbeat', {});
  }
  assert.equal(h.updates.streaming, true);
  assert.equal(h.connections.length, 1);
  assert.equal(h.states.length, 1);
  assert.deepEqual(h.snapshots, []);
});

test('an outdated or malformed saved selection can still load the initial catalog', async () => {
  const h = await harness();
  h.updates.subscribe('outdated-camera-preference', 'invalid-session');
  assert.equal(h.connections[0]!.url, '/api/events');
  assert.equal(h.updates.camera, null);
  assert.equal(h.updates.session, null);
  h.connections[0]!.send('state', { version: 1, catalog: { default_camera_id: 'a'.repeat(16) } });
  assert.equal(h.states.length, 1);
});

test('events and errors from a previous selection cannot update the new player', async () => {
  const h = await harness();
  h.updates.subscribe('a'.repeat(16));
  const old = h.connections[0];
  h.updates.subscribe('b'.repeat(16));
  old!.send('state', { version: 1, status: { state: 'live' } });
  old!.send('heartbeat', {});
  old!.fail();
  assert.equal(h.states.length, 0);
  assert.equal(h.errors(), 0);
  assert.equal(h.updates.streaming, false);
});

test('repeated connection errors do not postpone fallback, and recovery cancels polling', async () => {
  const h = await harness();
  h.updates.subscribe(null);
  h.connections[0]!.fail();
  for (let i = 0; i < 4; i++) {
    await h.advance(2000);
    h.connections[0]!.fail();
  }
  await h.advance(2000);
  assert.equal(h.snapshots.length, 1);
  await h.advance(15000);
  assert.equal(h.snapshots.length, 2);
  h.connections[0]!.send('state', { version: 1 });
  await h.advance(16000);
  assert.equal(h.snapshots.length, 2);
});

test('without EventSource one combined snapshot runs every 15 seconds', async () => {
  const h = await harness({ supported: false });
  h.updates.subscribe('a'.repeat(16), 'b'.repeat(32));
  await h.flush();
  assert.equal(h.connections.length, 0);
  assert.equal(h.snapshots.length, 1);
  assert.equal(h.snapshots[0]!.url, `/api/snapshot?camera=${'a'.repeat(16)}&session=${'b'.repeat(32)}`);
  await h.advance(14999);
  assert.equal(h.snapshots.length, 1);
  await h.advance(1);
  assert.equal(h.snapshots.length, 2);
});

test('backgrounding suspends updates, returning reconnects, and pagehide cannot reopen a stream', async () => {
  const h = await harness();
  h.updates.subscribe('a'.repeat(16), 'b'.repeat(32));
  h.document.hidden = true;
  h.document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(h.connections[0]!.closed, true);
  await h.advance(60000);
  assert.equal(h.snapshots.length, 0);
  h.document.hidden = false;
  h.document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(h.connections.length, 2);
  assert.equal(h.updates.session, 'b'.repeat(32));
  h.window.dispatchEvent(new Event('pagehide'));
  h.updates.subscribe('a'.repeat(16)); // Replay releases its lease during pagehide.
  await h.advance(60000);
  assert.equal(h.connections.length, 2);
  assert.equal(h.snapshots.length, 0);
});

test('a silent stream reconnects after the heartbeat deadline', async () => {
  const h = await harness();
  h.updates.subscribe(null);
  h.connections[0]!.send('state', { version: 1 });
  await h.advance(30000);
  h.connections[0]!.send('heartbeat', {});
  await h.advance(44999);
  assert.equal(h.connections.length, 1);
  await h.advance(1);
  assert.equal(h.connections.length, 2);
  assert.equal(h.connections[0]!.closed, true);
});

test('a permanently rejected event endpoint is retried without a busy loop', async () => {
  const h = await harness();
  h.updates.subscribe(null);
  h.connections[0]!.fail(2);
  await h.advance(29999);
  assert.equal(h.connections.length, 1);
  assert.equal(h.snapshots.length, 2);
  await h.advance(1);
  assert.equal(h.connections.length, 2);
});

test('a late fallback response from a previous camera is ignored', async () => {
  const pending: Array<(value: Response) => void> = [];
  const h = await harness({
    supported: false,
    fetcher: () => new Promise<Response>((resolve) => pending.push(resolve)),
  });
  h.updates.subscribe('a'.repeat(16));
  h.updates.subscribe('b'.repeat(16));
  assert.equal(h.snapshots[0]!.options!.signal!.aborted, true);
  pending[0]!(testDouble<Response>({ ok: true, json: async () => ({ version: 1, camera: 'old' }) }));
  await h.flush();
  assert.deepEqual(h.states, [] as BackendSnapshot[]);
  pending[1]!(testDouble<Response>({ ok: true, json: async () => ({ version: 1, camera: 'current' }) }));
  await h.flush();
  assert.equal(h.states.length, 1);
  const state = h.states[0]!;
  assert('camera' in state);
  assert.equal(state.camera, 'current');
});
