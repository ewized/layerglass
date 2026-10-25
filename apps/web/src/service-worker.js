import { SHELL_CACHE_PREFIX, SHELL_PATHS, shellPath } from './static/pwa-shell.js';

// Development defaults to network-only. Opt-in offline releases keep the normal
// waiting lifecycle so an update does not reload playback or discard history.
const revision = '__APP_SHELL_REVISION__';
const cacheEnabled = __PWA_CACHE_ENABLED__;
const cacheName = `${SHELL_CACHE_PREFIX}${revision}`;

self.addEventListener('install', event => {
  if (!cacheEnabled) {
    // Replace an existing caching worker immediately, including open app windows.
    // Claiming clients does not reload them; their next request uses the network.
    event.waitUntil(self.skipWaiting());
    return;
  }
  event.waitUntil((async () => {
    const cache = await caches.open(cacheName);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const results = await Promise.allSettled(SHELL_PATHS.map(async path => {
        const response = await fetch(path, { cache: 'no-store', redirect: 'error', signal: controller.signal });
        // A proxy error or a deployment midway through installation must not
        // replace a complete working shell with a partial/mixed release.
        if (!response.ok || response.headers.get('X-App-Shell-Revision') !== revision) {
          throw new Error('Incomplete app update');
        }
        await cache.put(path, response);
      }));
      if (results.some(result => result.status === 'rejected')) throw new Error('App update unavailable');
    } catch (error) {
      await caches.delete(cacheName);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith(SHELL_CACHE_PREFIX) && (!cacheEnabled || name !== cacheName))
      .map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

if (cacheEnabled) self.addEventListener('fetch', event => {
  const path = shellPath(event.request, self.location.origin);
  if (!path) return; // Media/SSE bypass the worker entirely, including streaming bodies.
  event.respondWith((async () => {
    const cache = await caches.open(cacheName);
    const cached = await cache.match(path);
    if (cached) return cached;
    // Storage can be evicted by the OS. Do not persist an unverified response
    // from a different release; the next worker installation repairs the shell.
    return fetch(event.request);
  })());
});
