import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import { SHELL_PATHS, shellPath } from '../src/pwa-shell.js';

const origin = 'https://viewer.test';
const request = (path: string, options?: RequestInit) => new Request(new URL(path, origin), options);

test('offline caching admits only explicit public shell resources', () => {
  for (const path of SHELL_PATHS) assert.equal(shellPath(request(path), origin), path);
  for (const path of [
    '/api/snapshot',
    '/api/cameras',
    '/api/events',
    '/api/status',
    '/api/cameras/123/configure',
    '/api/discover',
    '/api/sessions',
    '/healthz',
    '/stream/abc/live.m3u8',
    '/replay/abc/video',
    '/replay/abc/segment-0.ts',
    '/replay/abc/frame.jpg',
    '/replay/abc/preview.jpg?at=2',
    '/static/unknown.js',
    '/service-worker.js',
    '/?camera=private',
    '/static/player.js?access_code=private',
  ]) {
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
  const files = await fs.readdir(new URL('../../../dist/browser/apps/layerglass/src/', import.meta.url), {
    recursive: true,
  });
  for (const file of files.filter((file) => /\.(?:m?js|css)$/.test(file) && file !== 'service-worker.js')) {
    assert.ok(SHELL_PATHS.includes('/static/' + file), `Missing offline dependency: ${file}`);
  }
  const modules = JSON.parse(await fs.readFile(new URL('../browser-modules.json', import.meta.url), 'utf8'));
  for (const name of modules) {
    const files = await fs.readdir(new URL(`../../../dist/browser/apps/${name}/src/`, import.meta.url), {
      recursive: true,
    });
    for (const file of files.filter((file) => /\.m?js$/.test(file))) {
      assert.ok(
        SHELL_PATHS.includes(`/${name}/src/${file}`),
        `Missing offline provider dependency: ${name}/${file}`,
      );
    }
  }
  assert.equal(new Set(SHELL_PATHS).size, SHELL_PATHS.length);
  for (const path of SHELL_PATHS) {
    const file =
      path === '/'
        ? new URL('../../../dist/browser/apps/layerglass/src/index.html', import.meta.url)
        : path === '/manifest.webmanifest'
          ? new URL('../../../dist/browser/apps/layerglass/src/manifest.webmanifest', import.meta.url)
          : path.startsWith('/static/')
            ? new URL(
                '../../../dist/browser/apps/layerglass/src/' + path.slice('/static/'.length),
                import.meta.url,
              )
            : new URL('../../../dist/browser/apps' + path, import.meta.url);
    assert.ok((await fs.stat(file)).isFile(), `Missing shell file: ${path}`);
  }
});
