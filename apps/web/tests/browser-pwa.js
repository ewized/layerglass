import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { setTimeout as delay } from 'node:timers/promises';
import { SHELL_PATHS, SHELL_CACHE_PREFIX } from '../static/pwa-shell.js';
import { waitForPlayer } from './player-page.js';

const base = process.env.VIEWER_URL || 'http://127.0.0.1:8080';
const selected = process.env.BROWSER;

for (const [name, type] of Object.entries({ chromium, webkit })) {
  if (selected && selected !== name) continue;
  const browser = await type.launch({ headless: true });
  const context = await browser.newContext({ serviceWorkers: 'allow', viewport: { width: 414, height: 896 }, isMobile: true, hasTouch: true });
  const fixture = process.env.FIXTURE_PWA === '1';
  // Playwright 1.61 WebKit rejects SW navigations in setOffline mode (issue
  // 42775). Test cached navigation against an unavailable fixture backend,
  // with matching browser offline state, instead of skipping offline coverage.
  if (name === 'webkit' && fixture) await context.addInitScript(() => {
    const online = Object.getOwnPropertyDescriptor(Navigator.prototype, 'onLine').get;
    Object.defineProperty(navigator, 'onLine', { get: () => !sessionStorage.getItem('pwa-test-offline') && online.call(navigator) });
  });
  let page = await context.newPage();
  const errors = [];
  const messages = [];
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => messages.push(message.text()));
  const ready = async () => {
    await page.waitForFunction(() => navigator.serviceWorker?.controller, null, { timeout: 30000 });
    await waitForPlayer(page, ({ app }) => app.video.readyState >= 2 && !app.video.paused && app.pageReplay.session?.ready, null, { timeout: 45000 });
  };
  const cacheKeys = () => page.evaluate(() => caches.keys());
  const shellCaches = async () => (await cacheKeys()).filter(name => name.startsWith(SHELL_CACHE_PREFIX));
  const offlineReload = async () => {
    if (name === 'webkit') {
      if (!fixture) return false;
      await context.request.post(`${base}/__fixture/pwa-network?offline=1`);
      assert.equal((await context.request.get(`${base}/static/player.js`)).status(), 503);
      await page.evaluate(() => { sessionStorage.setItem('pwa-test-offline', '1'); window.dispatchEvent(new Event('offline')); });
    } else await context.setOffline(true);
    const response = await page.reload({ waitUntil: 'domcontentloaded' });
    assert.equal(response.status(), 200);
    assert.equal(response.fromServiceWorker(), true);
    await page.locator('#offline-icon').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#loader').isVisible(), false);
    return true;
  };
  const resumeOnline = async () => {
    if (name === 'webkit' && fixture) {
      await context.request.post(`${base}/__fixture/pwa-network`);
      await page.evaluate(() => { sessionStorage.removeItem('pwa-test-offline'); window.dispatchEvent(new Event('online')); });
    } else await context.setOffline(false);
  };
  try {
    let navigation = await page.goto(base, { waitUntil: 'domcontentloaded' });
    assert.equal(await page.evaluate(() => isSecureContext), true, 'Use secure localhost or HTTPS');
    await ready();
    const manifest = await page.evaluate(async () => {
      const response = await fetch(document.querySelector('link[rel=manifest]').href);
      return { type: response.headers.get('Content-Type'), value: await response.json() };
    });
    assert.match(manifest.type, /application\/manifest\+json/);
    assert.equal(manifest.value.display, 'standalone');
    assert.equal(manifest.value.start_url, '/');
    for (const icon of manifest.value.icons) {
      assert.deepEqual(await page.evaluate(async url => {
        const image = new Image(); image.src = url; await image.decode();
        return [image.naturalWidth, image.naturalHeight];
      }, icon.src), icon.sizes.split('x').map(Number));
    }
    if (process.env.PWA_CACHE_ENABLED === '0') {
      for (let launch = 0; launch < 2; launch++) {
        assert.equal(navigation.fromServiceWorker(), false);
        assert.equal(navigation.headers()['cache-control'], 'no-store');
        const styleResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/static/style.css');
        await page.evaluate(() => fetch('/static/style.css').then(response => response.text()));
        const style = await styleResponse;
        assert.equal(style.fromServiceWorker(), false);
        assert.equal(style.headers()['cache-control'], 'no-store');
        assert.equal(style.headers()['x-app-shell-revision'], navigation.headers()['x-app-shell-revision']);
        assert.deepEqual(await shellCaches(), []);
        assert.match(await page.evaluate(() => fetch('/service-worker.js').then(response => response.text())), /const cacheEnabled = false;/);
        if (launch === 0) {
          navigation = await page.reload({ waitUntil: 'load' });
          await ready();
        }
      }
      assert.deepEqual(errors, []);
      console.log(`${name}: install metadata, network-only worker, empty app caches, fresh HTML/CSS on reload and native playback passed`);
      continue;
    }
    const cached = await page.evaluate(async prefix => {
      const names = (await caches.keys()).filter(name => name.startsWith(prefix));
      return (await (await caches.open(names[0])).keys()).map(request => new URL(request.url).pathname).sort();
    }, SHELL_CACHE_PREFIX);
    assert.deepEqual(cached, [...SHELL_PATHS].sort());

    // API, video and manifests with private query metadata remain network-only.
    for (const path of ['/api/cameras', '/api/snapshot', '/static/player.js?private=never-cache']) {
      assert.equal(await page.evaluate(async path => {
        await fetch(path);
        return Boolean(await caches.match(path));
      }, path), false);
    }
    const before = await page.evaluate(async () => {
      const app = await import('/static/player.js');
      return { session: app.pageReplay.session.session_id, fallback: app.streamFallback };
    });
    await context.setOffline(true);
    await page.locator('#offline-icon').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#loader').isVisible(), false);
    assert.equal(await page.locator('#overlay-title').textContent(), 'Offline');
    assert.equal(await page.locator('video').evaluate(video => video.paused), true);
    await page.waitForFunction(() => document.querySelector('#live-button').disabled &&
      !document.querySelector('#live-button').classList.contains('at-live'));
    await delay(1200);
    await context.setOffline(false);
    await ready();
    await page.locator('#overlay').waitFor({ state: 'hidden' });
    assert.deepEqual(await page.evaluate(async () => {
      const app = await import('/static/player.js');
      return { session: app.pageReplay.session.session_id, fallback: app.streamFallback };
    }), before, 'Connection recovery preserves DVR session and transport');

    // Cached shell also starts with no network, rather than spinning forever.
    const coldOffline = await offlineReload();
    await resumeOnline();
    await ready();
    console.log(`${name}: install metadata, ${coldOffline ? 'cached launch without backend' : 'online launch'}, uncached media/API, and automatic recovery passed`);

    if (process.env.FIXTURE_PWA === '1') {
      // Seed another app's cache to prove cleanup is scoped to our own prefix.
      await page.evaluate(async () => { await (await caches.open('unrelated-test-cache')).put('/unrelated', new Response('keep')); });
      const current = await shellCaches();
      const session = await page.evaluate(async () => (await import('/static/player.js')).pageReplay.session.session_id);
      const revision = (await (await context.request.post(`${base}/__fixture/pwa-update`)).json()).revision;
      await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration()).update(); });
      await page.waitForFunction(async () => Boolean((await navigator.serviceWorker.getRegistration()).waiting), null, { timeout: 30000 });
      assert.deepEqual((await shellCaches()).sort(), [...current, SHELL_CACHE_PREFIX + revision].sort());
      assert.equal(await page.evaluate(async () => (await import('/static/player.js')).pageReplay.session.session_id), session);
      assert.equal(await page.locator('video').evaluate(video => video.paused), false);
      await page.close();
      await delay(1000); // All app windows must close before the waiting release activates.
      page = await context.newPage();
      await page.goto(base, { waitUntil: 'domcontentloaded' });
      await ready();
      assert.deepEqual(await shellCaches(), [SHELL_CACHE_PREFIX + revision]);
      assert.ok((await cacheKeys()).includes('unrelated-test-cache'));

      const broken = (await (await context.request.post(`${base}/__fixture/pwa-update?fail=1`)).json()).revision;
      await page.evaluate(async () => {
        const registration = await navigator.serviceWorker.getRegistration();
        const done = new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('Update did not finish')), 30000);
          registration.addEventListener('updatefound', () => {
            const worker = registration.installing;
            worker.addEventListener('statechange', () => {
              if (['redundant', 'installed'].includes(worker.state)) { clearTimeout(timeout); resolve(worker.state); }
            });
          }, { once: true });
        });
        await registration.update();
        if (await done !== 'redundant') throw new Error('Incomplete release unexpectedly installed');
      });
      assert.ok(!(await cacheKeys()).includes(SHELL_CACHE_PREFIX + broken));
      assert.deepEqual(await shellCaches(), [SHELL_CACHE_PREFIX + revision]);
      await offlineReload();
      await resumeOnline();
      console.log(`${name}: deferred updates, cache cleanup and interrupted update rollback passed`);

      // Migrate an already installed, cache-first PWA while its player stays open.
      await ready();
      const migrationSession = await page.evaluate(async () => (await import('/static/player.js')).pageReplay.session.session_id);
      await page.evaluate(() => {
        window.pwaMigrationMarker = true;
        window.pwaPreviousController = navigator.serviceWorker.controller;
      });
      await context.request.post(`${base}/__fixture/pwa-update?cache=0`);
      await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration()).update(); });
      await page.waitForFunction(() => navigator.serviceWorker.controller !== window.pwaPreviousController &&
        navigator.serviceWorker.controller?.state === 'activated', null, { timeout: 30000 });
      assert.deepEqual(await shellCaches(), []);
      assert.equal(await page.evaluate(() => window.pwaMigrationMarker), true, 'Migration must not reload playback');
      assert.equal(await page.evaluate(async () => (await import('/static/player.js')).pageReplay.session.session_id), migrationSession);
      assert.equal(await page.locator('video').evaluate(video => video.paused), false);
      assert.ok((await cacheKeys()).includes('unrelated-test-cache'));

      for (let release = 0; release < 2; release++) {
        const latest = (await (await context.request.post(`${base}/__fixture/pwa-update?cache=0`)).json()).revision;
        const styleResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/static/style.css');
        const response = await page.reload({ waitUntil: 'load' });
        const style = await styleResponse;
        for (const asset of [response, style]) {
          assert.equal(asset.fromServiceWorker(), false);
          assert.equal(asset.headers()['cache-control'], 'no-store');
          assert.equal(asset.headers()['x-app-shell-revision'], latest);
        }
        await ready();
        assert.deepEqual(await shellCaches(), []);
      }
      console.log(`${name}: immediate cache-first migration, scoped cache removal, retained playback and fresh UI on consecutive reloads passed`);
    }
    assert.deepEqual(errors, []);
  } catch (error) {
    console.error(name, await page.evaluate(() => ({ online: navigator.onLine,
      title: document.querySelector('#overlay-title')?.textContent,
      overlayHidden: document.querySelector('#overlay')?.hidden,
      iconHidden: document.querySelector('#offline-icon')?.hasAttribute('hidden') })), messages.slice(-12));
    throw error;
  } finally {
    if (fixture) {
      await context.request.post(`${base}/__fixture/pwa-network`);
      await context.request.post(`${base}/__fixture/pwa-update?cache=1`);
    }
    await context.setOffline(false);
    await browser.close();
  }
}
