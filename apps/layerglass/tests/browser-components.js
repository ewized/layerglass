import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';

const base = process.env.VIEWER_URL || 'http://127.0.0.1:8080';

async function run(name, engine) {
  const browser = await engine.launch({ headless: true, args: name === 'chromium' ? ['--no-sandbox'] : [] });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const errors = [];
  const mutations = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (request.method() === 'POST' && /\/(configure|forget)$/.test(new URL(request.url()).pathname)) mutations.push(request.url());
  });
  try {
    await page.goto(base);
    await page.waitForFunction(() => document.querySelector('video')?.videoWidth > 0 && !document.querySelector('video').paused && document.querySelector('#overlay').hidden,
      undefined, { timeout: 45000 });
    const initial = await page.evaluate(async () => {
      const { components } = await import('/static/components/index.js');
      const app = await import('/static/player.js');
      window.componentVideo = app.video;
      window.componentSession = app.pageReplay.session.session_id;
      return {
        registered: [...components].every(([tag, type]) => customElements.get(tag) === type),
        native: [...document.querySelectorAll('*')].filter(node => node.localName.startsWith('printer-'))
          .every(node => node.matches(':defined') && node instanceof customElements.get(node.localName)),
        count: components.size, player: app.playerChrome === document.querySelector('printer-player'),
        idsUnique: new Set([...document.querySelectorAll('[id]')].map(node => node.id)).size === document.querySelectorAll('[id]').length,
      };
    });
    assert.deepEqual(initial, { registered: true, native: true, count: 13, player: true, idsUnique: true });
    await page.evaluate(() => {
      const mount = document.createElement('div');
      mount.id = 'component-test';
      mount.style.cssText = 'position:fixed;inset:10px 10px auto;z-index:50;background:#111;padding:8px;';
      const left = document.createElement('printer-list');
      const right = document.createElement('printer-list');
      left.id = 'component-left';
      right.id = 'component-right';
      window.componentCamera = { id: 'f'.repeat(16), host: '192.168.50.8', name: 'Printer <img src=x onerror=alert(1)>', configured: false, setup: { type: 'access_code' } };
      // Properties can be set before connection; two lists can use the same printer.
      left.update([window.componentCamera], null);
      right.update([window.componentCamera], null);
      window.componentSaves = [];
      left.addEventListener('printer-save', event => window.componentSaves.push(event.detail));
      mount.append(left, right);
      document.body.append(mount);
    });
    const left = page.locator('#component-left');
    const right = page.locator('#component-right');
    assert.equal(await left.locator('.printer-name').textContent(), 'Printer <img src=x onerror=alert(1)>');
    assert.equal(await left.locator('img').count(), 0, 'Server-provided names must remain text.');
    assert.notEqual(await left.locator('input').getAttribute('id'), await right.locator('input').getAttribute('id'));
    await left.locator('.printer-access').click();
    await left.locator('input').fill('12345678');
    await page.evaluate(() => {
      window.componentInput = document.querySelector('#component-left input');
      document.querySelector('#component-left').update([{ ...window.componentCamera, name: 'Renamed printer' }], null);
    });
    assert.equal(await left.locator('input').inputValue(), '12345678');
    assert.equal(await right.locator('input').isVisible(), false, 'Editing one list must not open another list.');
    await left.locator('.printer-code-save').click();
    assert.equal(await page.evaluate(() => window.componentSaves.length), 1);
    await page.evaluate(() => {
      const list = document.querySelector('#component-left');
      list.remove();
      document.querySelector('#component-test').prepend(list);
    });
    assert.equal(await left.locator('input').evaluate(input => input === window.componentInput), true);
    assert.equal(await left.locator('input').inputValue(), '12345678', 'Reconnection must retain the same editor and draft.');
    await left.locator('.printer-code-save').click();
    assert.deepEqual(await page.evaluate(() => window.componentSaves), [
      { cameraId: 'f'.repeat(16), code: '12345678' }, { cameraId: 'f'.repeat(16), code: '12345678' },
    ], 'Each gesture must emit one action after reconnection.');
    await page.evaluate(() => document.querySelector('#component-left').update([{ ...window.componentCamera, configured: true }], null));
    assert.equal(await left.locator('input').isVisible(), false);
    assert.equal(await left.locator('.printer-access').isVisible(), false);
    assert.equal(await left.locator('input').inputValue(), '');
    assert.equal(await right.locator('.printer-access').isVisible(), true);
    await page.evaluate(() => document.querySelector('#component-test').remove());
    assert.deepEqual(mutations, [], 'Reusable UI elements must leave network operations to their consumer.');

    await page.evaluate(async () => {
      const app = await import('/static/player.js');
      const stats = app.playerTools.stats;
      const readState = stats.readState;
      window.statsReads = 0;
      window.componentStats = stats;
      window.statsParent = stats.parentElement;
      window.statsNext = stats.nextSibling;
      stats.configure({ readState: () => { window.statsReads++; return readState(); }, video: app.video,
        image: document.querySelector('#jpeg'), player: app.playerChrome });
      stats.show(true);
    });
    await page.waitForFunction(() => window.statsReads >= 2);
    await page.locator('#player-stats [data-stats-section="video"]').evaluate(list => {
      window.componentVideoCells = [...list.querySelectorAll('dd')].map(cell => [cell.dataset.statKey, cell]);
    });
    const reads = await page.evaluate(() => { window.componentStats.remove(); return window.statsReads; });
    await page.waitForTimeout(1200);
    assert.equal(await page.evaluate(() => window.statsReads), reads, 'Removing stats must stop its sampling timer.');
    await page.evaluate(() => window.statsParent.insertBefore(window.componentStats, window.statsNext));
    await page.waitForFunction(before => window.statsReads >= before + 2, reads);
    assert.equal(await page.locator('#player-stats [data-stats-section="video"]').evaluate(list =>
      window.componentVideoCells.every(([key, cell]) =>
        [...list.querySelectorAll('dd')].find(node => node.dataset.statKey === key) === cell)), true,
    'Reconnecting stats must reuse its existing diagnostic cells.');
    assert.equal(await page.locator('#player-stats [data-stats-section]').evaluateAll(lists => lists.every(list => {
      const keys = [...list.querySelectorAll('dd')].map(cell => cell.dataset.statKey);
      return new Set(keys).size === keys.length;
    })), true, 'New telemetry may add rows, but reconnecting cannot duplicate keys.');
    await page.locator('#close-stats').click();
    const closedReads = await page.evaluate(() => window.statsReads);
    await page.waitForTimeout(1200);
    assert.equal(await page.evaluate(() => window.statsReads), closedReads, 'Hidden stats must not keep sampling.');
    assert.deepEqual(await page.evaluate(async () => {
      const app = await import('/static/player.js');
      return { video: app.video === window.componentVideo, session: app.pageReplay.session.session_id === window.componentSession,
        playing: !app.video.paused };
    }), { video: true, session: true, playing: true });
    assert.deepEqual(errors, []);
    console.log(`${name}: native custom-element registration, synchronous startup, independent printer lists, safe names, unique labels, draft preservation, single actions after reconnection, stats timer cleanup, and unchanged video/session passed`);
    await page.goto('about:blank');
  } finally { await browser.close(); }
}

const results = await Promise.allSettled([run('chromium', chromium), run('webkit', webkit)]);
for (const result of results) if (result.status === 'rejected') { console.error(result.reason); process.exitCode = 1; }
