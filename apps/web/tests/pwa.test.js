import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import { SHELL_PATHS, shellPath } from '../src/pwa-shell.js';

const origin = 'https://viewer.test';
const request = (path, options) => new Request(new URL(path, origin), options);

test('offline caching admits only explicit public shell resources', () => {
  for (const path of SHELL_PATHS) assert.equal(shellPath(request(path), origin), path);
  for (const path of ['/api/snapshot', '/api/cameras', '/api/events', '/api/status',
    '/api/cameras/123/configure', '/api/discover', '/api/sessions', '/healthz',
    '/stream/abc/live.m3u8', '/replay/abc/video', '/replay/abc/segment-0.ts',
    '/replay/abc/frame.jpg', '/replay/abc/preview.jpg?at=2', '/static/unknown.js', '/service-worker.js',
    '/?camera=private', '/static/player.js?access_code=private']) {
    assert.equal(shellPath(request(path), origin), null, path);
  }
});

test('cross-origin, range and mutation requests never enter the app cache', () => {
  assert.equal(shellPath(new Request('https://another.test/static/player.js'), origin), null);
  assert.equal(shellPath(request('/static/player.js', { method: 'POST', body: 'private' }), origin), null);
  assert.equal(shellPath(request('/static/player.js', { headers: { Range: 'bytes=0-20' } }), origin), null);
  assert.equal(shellPath(request('/', { method: 'HEAD' }), origin), null);
});

test('the offline shell includes the full shipped module graph and media worker', async () => {
  const files = await fs.readdir(new URL('../src/', import.meta.url), { recursive: true });
  for (const file of files.filter(file => /\.(?:m?js|css)$/.test(file) && file !== 'service-worker.js')) {
    assert.ok(SHELL_PATHS.includes('/static/' + file), `Missing offline dependency: ${file}`);
  }
  assert.equal(new Set(SHELL_PATHS).size, SHELL_PATHS.length);
  for (const path of SHELL_PATHS) {
    const file = path === '/' ? 'index.html' : path === '/manifest.webmanifest' ? 'manifest.webmanifest' : path.slice('/static/'.length);
    assert.ok((await fs.stat(new URL('../src/' + file, import.meta.url))).isFile(), `Missing shell file: ${path}`);
  }
});
