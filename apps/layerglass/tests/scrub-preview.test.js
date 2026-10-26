import assert from 'node:assert/strict';
import test from 'node:test';
import { previewPoint, previewLeft, previewSheet } from '../src/scrub-preview.js';

const track = { min: 0, max: 100, start: 0, end: 100, left: 10, width: 216 };

test('hover uses the displayed range and accounts for the native thumb inset', () => {
  assert.deepEqual(previewPoint({ ...track, x: 118 }), { fraction: 0.5, time: 50 });
  assert.deepEqual(previewPoint({ ...track, x: -50 }), { fraction: 0, time: 0 });
  assert.deepEqual(previewPoint({ ...track, x: 1000 }), { fraction: 1, time: 99.95 });
});

test('a projected Live edge never requests footage that has not been recorded', () => {
  const point = previewPoint({ ...track, max: 106, x: 1000 });
  assert.equal(point.time, 99.95);
  assert.deepEqual(previewSheet({ ...point, start: 0, end: 100 }), { start: 90, count: 2, index: 1 });
});

test('paused/scrubbing coordinates remain fixed as Live grows', () => {
  const first = previewPoint({ ...track, x: 98 });
  const later = previewPoint({ ...track, end: 120, x: 98 });
  assert.deepEqual(later, first);
});

test('preview respects storage trimming and a later page session origin', () => {
  const point = previewPoint({ ...track, start: 13.6, value: 0 });
  assert.equal(point.time, 13.6);
  assert.deepEqual(previewSheet({ ...point, start: 13.6, end: 100 }), { start: 13.6, count: 4, index: 0 });
});

test('keyboard and pointer selections refer to the same frame', () => {
  assert.deepEqual(previewPoint({ ...track, value: 50 }), previewPoint({ ...track, x: 118 }));
  assert.equal(previewSheet({ time: 51.9, start: 0, end: 100 }).index, 4);
});

test('six five-second cells reuse one thirty-second sheet', () => {
  for (let index = 0; index < 6; index++) {
    assert.deepEqual(previewSheet({ time: index * 5 + 1, start: 0, end: 90 }), { start: 0, count: 6, index });
  }
  assert.deepEqual(previewSheet({ time: 30, start: 0, end: 90 }), { start: 30, count: 6, index: 0 });
});

test('a partial sheet never includes future frames or a cell too close to its end', () => {
  assert.deepEqual(previewSheet({ time: 9.9, start: 0, end: 10 }), { start: 0, count: 2, index: 1 });
  assert.deepEqual(previewSheet({ time: 10, start: 0, end: 10.01 }), { start: 0, count: 2, index: 1 });
  assert.deepEqual(previewSheet({ time: 10, start: 0, end: 10.06 }), { start: 0, count: 3, index: 2 });
  assert.deepEqual(previewSheet({ time: 35, start: 0, end: 36 }), { start: 30, count: 2, index: 1 });
});

test('trimmed and later page origins cannot include earlier frames', () => {
  assert.deepEqual(previewSheet({ time: 25, start: 13.6, end: 100 }), { start: 13.6, count: 4, index: 2 });
  assert.deepEqual(previewSheet({ time: 32, start: 31.1, end: 45 }), { start: 31.1, count: 3, index: 0 });
  for (const time of [-1, NaN, Infinity, 100]) assert.equal(previewSheet({ time, start: 0, end: 100 }), null);
  assert.equal(previewSheet({ time: 0, start: 0, end: 0.04 }), null);
});

test('thumbnail placement stays inside the player at both ends and on narrow windows', () => {
  assert.equal(previewLeft(0, 374, 176), 0);
  assert.equal(previewLeft(1, 374, 176), 198);
  assert.equal(previewLeft(0.5, 374, 176), 99);
  assert.equal(previewLeft(0.5, 100, 176), 0);
});

test('empty, unavailable, or invalid timelines have no preview', () => {
  assert.equal(previewPoint({ ...track, end: 0, x: 30 }), null);
  assert.equal(previewPoint({ ...track, max: 0, x: 30 }), null);
  assert.equal(previewPoint({ ...track, start: NaN, x: 30 }), null);
});
