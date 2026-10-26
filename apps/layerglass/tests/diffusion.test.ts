import assert from 'node:assert/strict';
import test from 'node:test';
import { diffusionSampleSize, diffusionPalette, diffusionGradient } from '../src/diffusion.js';

function frame(width: number, height: number, pixel: (x: number, y: number) => readonly number[]) {
  return {
    width,
    height,
    data: Uint8ClampedArray.from(
      Array.from({ length: width * height }, (_, i) => [
        ...pixel(i % width, Math.floor(i / width)),
        255,
      ]).flat(),
    ),
  };
}

test('a uniform frame retains its color in every gradient region', () => {
  for (const color of [
    [0, 0, 0],
    [255, 255, 255],
    [12, 145, 237],
  ]) {
    assert.deepEqual(
      diffusionPalette(frame(32, 18, () => color)),
      Array.from({ length: 5 }, () => color),
    );
  }
});

test('bright and dark pixels are averaged in linear light', () => {
  const palette = diffusionPalette(frame(32, 18, (x) => (x % 2 ? [255, 255, 255] : [0, 0, 0])));
  assert.deepEqual(palette[4], [188, 188, 188]);
});

test('Gaussian weighting keeps each corner related to the matching part of the frame', () => {
  const colors = [
    [255, 0, 0],
    [0, 255, 0],
    [0, 0, 255],
    [255, 255, 0],
  ];
  const palette = diffusionPalette(frame(32, 32, (x, y) => colors[(y >= 16 ? 2 : 0) + (x >= 16 ? 1 : 0)]!));
  assert(palette[0]![0]! > 220 && palette[0]![1]! < 150 && palette[0]![2]! < 150);
  assert(palette[1]![1]! > 220 && palette[1]![0]! < 150 && palette[1]![2]! < 150);
  assert(palette[2]![2]! > 220 && palette[2]![0]! < 150 && palette[2]![1]! < 150);
  assert(palette[3]![0]! > 220 && palette[3]![1]! > 220 && palette[3]![2]! < 150);
  assert.deepEqual(palette[4], [188, 188, 137]);
});

test('spatial weighting is symmetric and a changed sample size rebuilds its weights', () => {
  for (const [width, height] of [
    [32, 18],
    [18, 32],
    [1, 1],
    [32, 18],
  ] as const) {
    const palette = diffusionPalette(frame(width, height, () => [225, 30, 65]));
    assert.deepEqual(
      palette,
      Array.from({ length: 5 }, () => [225, 30, 65]),
    );
  }
  const palette = diffusionPalette(frame(32, 18, (x) => (x < 16 ? [255, 0, 0] : [0, 0, 255])));
  assert.deepEqual(palette[0], palette[2]);
  assert.deepEqual(palette[1], palette[3]);
  assert.equal(palette[0]![0], palette[1]![2]);
  assert.equal(palette[0]![2], palette[1]![0]);
});

test('transparent pixels do not contribute hidden color', () => {
  const pixels = frame(2, 1, (x) => (x ? [0, 0, 255] : [255, 0, 0]));
  pixels.data[7] = 0;
  assert.deepEqual(
    diffusionPalette(pixels),
    Array.from({ length: 5 }, () => [255, 0, 0]),
  );
  pixels.data[3] = 0;
  assert.deepEqual(
    diffusionPalette(pixels),
    Array.from({ length: 5 }, () => [0, 0, 0]),
  );
});

test('sampling preserves aspect ratio with at most 32 pixels on either axis', () => {
  assert.deepEqual(diffusionSampleSize(1920, 1080), { width: 32, height: 18 });
  assert.deepEqual(diffusionSampleSize(1080, 1920), { width: 18, height: 32 });
  assert.deepEqual(diffusionSampleSize(1000, 1), { width: 32, height: 1 });
  assert.deepEqual(diffusionSampleSize(1, 1000), { width: 1, height: 32 });
});

test('CSS receives four spatial gradients and an opaque average base', () => {
  const gradient = diffusionGradient(Array.from({ length: 5 }, () => [12, 145, 237]));
  assert.equal((gradient.match(/radial-gradient/g) || []).length, 4);
  for (const position of ['0% 0%', '100% 0%', '0% 100%', '100% 100%'])
    assert(gradient.includes(`at ${position}`));
  assert(gradient.endsWith(', rgb(12 145 237)'));
});
