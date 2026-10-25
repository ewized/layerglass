import assert from 'node:assert/strict';
import test from 'node:test';
import { PrinterTimelineEvents, timelineTime, timelinePosition, groupTimelineEvents } from '../src/timeline-events.js';
import { PrinterHistory } from '../src/printer-history.js';

const session = { session_id: 'events-session', camera_id: 'printer', start_seconds: 0, end_seconds: 3000,
  clock: [{ position: 0, time: 1000 }] };
const batch = (samples, extra = {}) => ({ ...session, from: samples[0]?.[0] ?? 1000,
  until: samples.at(-1)?.[0] ?? 1000, samples: samples.map(([at, printer]) => ({ at, printer })), ...extra });
const state = (print_state, extra = {}) => ({ connection: 'connected', print_state, ...extra });
const types = model => model.events.map(event => [event.at, event.type]);
const model = options => { const value = new PrinterTimelineEvents(options); value.setSession(session); return value; };

test('joining a running print or existing error establishes a baseline without inventing events', () => {
  const events = model();
  events.apply(batch([[1000, state('RUNNING', { error: 42 })], [1001, state('RUNNING', { error: 42 })]]));
  assert.deepEqual(events.events, []);
});

test('observed start, pause, resume and finish use recorded sample times', () => {
  const events = model();
  events.apply(batch([[1000, state('IDLE')], [1001, state('PREPARE')], [1002, state('RUNNING')],
    [1003, state('PAUSE')], [1004, state('RUNNING')], [1005, state('FINISH')]]));
  assert.deepEqual(types(events), [[1001, 'started'], [1003, 'paused'], [1004, 'resumed'], [1005, 'finished']]);
  assert.deepEqual(events.visible(session).map(event => event.position), [1, 3, 4, 5]);
});

test('partial telemetry preserves known state without inventing a state for unknown reports', () => {
  const events = model();
  events.apply(batch([[1000, state('RUNNING', { error: 0 })], [1001, { nozzle: 200 }],
    [1002, { print_state: 'PAUSED' }], [1003, { error: '25' }], [1004, {}],
    [1005, { print_state: 'unrecognized state' }], [1006, state('RUNNING')], [1007, state('COMPLETED')]]));
  assert.deepEqual(types(events), [[1002, 'paused'], [1003, 'error'], [1007, 'finished']]);
});

test('explicit cancellation and failure stay distinct; idle alone does not imply cancellation', () => {
  const events = model();
  events.apply(batch([[1000, state('RUNNING', { error: 0 })], [1001, state('FAILED', { error: 44 })],
    [1002, state('RUNNING', { error: 0 })], [1003, state('CANCELED')],
    [1004, state('RUNNING')], [1005, state('IDLE')]]));
  assert.deepEqual(types(events), [[1001, 'failed'], [1002, 'started'], [1003, 'cancelled'], [1004, 'started']]);
});

test('job changes are explicit observations and late identity enrichment is not a new job', () => {
  const events = model();
  const job = (subtask_id, name = 'same.3mf') => state('RUNNING', { job: name, reported: { print: { subtask_id } } });
  events.apply(batch([[1000, state('RUNNING')], [1001, job('a')], [1002, job('a')],
    [1003, job('b')], [1004, job('b', 'next.3mf')]]));
  assert.deepEqual(types(events), [[1003, 'job'], [1004, 'job']]);
});

test('disconnections and long sample gaps break transition evidence', () => {
  const events = model();
  events.apply(batch([[1000, state('RUNNING')], [1001, state('RUNNING', { connection: 'stale' })],
    [1002, state('PAUSE')], [1003, state('RUNNING')], [1020, state('FINISH')],
    [1021, state('RUNNING')]]));
  assert.deepEqual(types(events), [[1003, 'resumed'], [1021, 'started']]);
});

test('repeated zero codes, strings, invalid codes and malformed packets do not create errors', () => {
  const events = model();
  events.apply(batch([[1000, state('RUNNING', { error: 0 })], [1001, { error: '000' }],
    [1002, { error: '4' }], [1003, { error: '4' }], [1004, { error: false }], [1005, { error: 7 }]]));
  assert.deepEqual(types(events), [[1002, 'error']]);
  for (const invalid of [null, {}, batch([[1006, state('PAUSE')]], { session_id: 'expired' }),
    batch([[1006, state('PAUSE')]], { camera_id: 'different' }), batch([], { from: 5, until: 4 }),
    batch([], { samples: [{ at: NaN, printer: state('PAUSE') }, { at: 1006, printer: [] }] })]) events.apply(invalid);
  assert.deepEqual(types(events), [[1002, 'error']]);
});

test('SSE overlap, duplicate timestamps, reordered payloads and history hydration deduplicate', () => {
  const events = model();
  const first = batch([[1000, state('IDLE')], [1001, state('RUNNING')], [1002, state('PAUSE')]]);
  events.apply(first); events.apply(first);
  events.apply(batch([[1002, state('PAUSE')], [1003, state('RUNNING')], [1003, state('RUNNING')]]));
  events.apply(batch([[1002, state('PAUSE')], [1000, state('IDLE')], [1001, state('RUNNING')]]));
  assert.deepEqual(types(events), [[1001, 'started'], [1002, 'paused'], [1003, 'resumed']]);
  assert.equal(new Set(events.events.map(event => event.id)).size, 3);
});

test('same-timestamp partial enrichment updates the baseline without a fabricated transition', () => {
  const events = model();
  events.apply(batch([[1000, { nozzle: 200 }]]));
  events.apply(batch([[1000, state('RUNNING', { error: 0 })]]));
  assert.deepEqual(events.events, []);
  events.apply(batch([[1001, state('PAUSE', { error: 7 })]]));
  assert.deepEqual(types(events), [[1001, 'error'], [1001, 'paused']]);
});

test('conflicting state at one timestamp cannot become false evidence for a later resume', () => {
  const events = model();
  events.apply(batch([[1000, state('RUNNING', { error: 0 })]]));
  events.apply(batch([[1000, state('PAUSE', { error: 5 })]]));
  events.apply(batch([[1001, state('RUNNING', { error: 6 })]]));
  assert.deepEqual(events.events, []);
});

test('an older explicit history window cannot compare its first reading to a future baseline', () => {
  const events = model();
  events.apply(batch([[1100, state('IDLE')]]));
  events.apply(batch([[1000, state('RUNNING')], [1001, state('PAUSE')]]));
  events.apply(batch([[1101, state('RUNNING')]]));
  assert.deepEqual(types(events), [[1001, 'paused'], [1101, 'started']]);
  assert.equal(events.last.at, 1101);
});

test('event summaries outlive stats-window eviction and do not request more data', () => {
  const events = model();
  let requests = 0;
  const history = new PrinterHistory(() => {}, { maxWindows: 2, fetcher: () => { requests++; },
    onSession: value => events.setSession(value), onSamples: value => events.apply(value) });
  history.setSession(session);
  for (let second = 0; second <= 2700; second++) {
    const print_state = second === 0 ? 'IDLE' : second < 900 ? 'RUNNING' : second < 1800 ? 'PAUSE' : 'RUNNING';
    history.apply(batch([[1000 + second, state(print_state)]]), false);
  }
  assert.equal(history.windows.size, 2);
  assert.deepEqual(types(events), [[1001, 'started'], [1900, 'paused'], [2800, 'resumed']]);
  assert.equal(events.visible(session).length, 3);
  assert.equal(requests, 0);
  history.setSession({ ...session, session_id: 'next' });
  assert.deepEqual(events.events, []);
  assert.equal(events.last, null);
});

test('camera and session reset remove prior evidence and accept only their own batches', () => {
  const events = model();
  events.apply(batch([[1000, state('IDLE')], [1001, state('RUNNING')]]));
  events.setSession({ ...session });
  assert.equal(events.events.length, 1);
  events.setSession({ ...session, camera_id: 'other' });
  events.apply(batch([[1002, state('PAUSE')]]));
  assert.deepEqual(events.events, []);
  events.setSession(null);
  assert.deepEqual(events.visible(session), []);
});

test('event count is bounded even during a long sequence of changing reports', () => {
  const events = model({ maxEvents: 4 });
  const samples = Array.from({ length: 40 }, (_, index) => [1000 + index, state(index % 2 ? 'PAUSE' : 'RUNNING')]);
  events.apply(batch(samples));
  assert.equal(events.events.length, 4);
  assert.deepEqual(events.events.map(event => event.at), [1036, 1037, 1038, 1039]);
});

test('clock mapping skips relay gaps and does not project future or pre-page footage', () => {
  const clocks = { ...session, end_seconds: 40, clock: [{ position: 0, time: 1000 }, { position: 20, time: 2000 }] };
  assert.equal(timelinePosition(clocks, 1005), 5);
  assert(Math.abs(timelinePosition(clocks, 1019.9) - 19.9) < 0.000001);
  assert.equal(timelinePosition(clocks, 1020), null);
  assert.equal(timelinePosition(clocks, 1500), null);
  assert.equal(timelinePosition(clocks, 2000), 20);
  assert.equal(timelinePosition(clocks, 2010), 30);
  assert.equal(timelinePosition(clocks, 2020), 40);
  assert.equal(timelinePosition(clocks, 2021), null);
  assert.equal(timelinePosition(clocks, 999), null);
  assert.equal(timelinePosition({ ...clocks, start_seconds: 6 }, 1005), null);
  assert.equal(timelinePosition({ ...clocks, clock: [] }, 1010), null);
  assert.equal(timelinePosition(clocks, NaN), null);
  assert.equal(timelineTime(clocks, 30), 2010);
});

test('retention removes discarded events while moving display windows only hide retained ones', () => {
  const events = model();
  events.apply(batch([[1000, state('IDLE')], [1001, state('RUNNING')], [1002, state('PAUSE')], [1003, state('RUNNING')]]));
  assert.deepEqual(events.visible(session, { start: 2.5, end: 5 }).map(event => event.type), ['resumed']);
  assert.equal(events.events.length, 3);
  assert.deepEqual(events.visible({ ...session, start_seconds: 2 }).map(event => event.type), ['paused', 'resumed']);
  assert.equal(events.events.length, 2);
  assert.deepEqual(events.visible({ ...session, session_id: 'stale' }), []);
});

test('dense markers group into small touch targets without changing event time or position', () => {
  const events = [{ position: 0 }, { position: 1 }, { position: 20 }, { position: 100 }];
  const groups = groupTimelineEvents(events, 0, 100, 300);
  assert.deepEqual(groups.map(group => group.events.length), [2, 1, 1]);
  assert.deepEqual(groups.map(group => group.fraction), [0, 0.2, 1]);
  assert.equal(groups[0].events[1], events[1]);
  assert.deepEqual(groupTimelineEvents(events, 0, 0, 300), []);
  assert.deepEqual(groupTimelineEvents(events, 0, 100, 0), []);
});
