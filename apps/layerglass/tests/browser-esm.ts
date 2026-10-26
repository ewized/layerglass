import type { BrowserType } from 'playwright';
import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';

const base = process.env.VIEWER_URL || 'http://127.0.0.1:8080';

async function run(name: string, engine: BrowserType) {
  const browser = await engine.launch({ headless: true, args: name === 'chromium' ? ['--no-sandbox'] : [] });
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const errors: Array<string> = [];
  const scripts: Array<string> = [];
  const workers: Array<string> = [];
  const failures: Array<string> = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('worker', (worker) => workers.push(new URL(worker.url()).pathname));
  page.on('response', (response) => {
    const path = new URL(response.url()).pathname;
    if (!path.endsWith('.js') && !path.endsWith('.mjs')) return;
    scripts.push(path);
    if (!response.ok()) failures.push(path);
    assert.match(response.headers()['content-type']!, /(?:text|application)\/javascript/);
  });
  try {
    await page.goto(base);
    await page.waitForFunction(
      () => {
        const video = document.querySelector<HTMLVideoElement>('video');
        return (
          (video?.videoWidth ?? Number.NaN) > 0 &&
          video!.readyState >= 2 &&
          !video!.paused &&
          document.querySelector<HTMLElementTagNameMap['printer-loading']>('#overlay')!.hidden
        );
      },
      undefined,
      { timeout: 45000 },
    );
    assert.deepEqual(
      await page
        .locator('script[src]')
        .evaluateAll((nodes: HTMLScriptElement[]) =>
          nodes.map((node) => ({ type: node.type, src: new URL(node.src).pathname })),
        ),
      [{ type: 'module', src: '/static/bootstrap.js' }],
    );
    const state = await page.evaluate(async () => {
      const app = await import('/static/player.js');
      const same = await import('/static/player.js');
      const { default: Hls } = await import('/static/vendor/hls.min.mjs');
      const { PageReplay } = await import('/static/replay.js');
      return {
        sameInstance: app === same && app.pageReplay === same.pageReplay,
        version: Hls.version,
        model: app.pageReplay instanceof PageReplay,
        delivery: app.videoStream?.connected,
        workerPath: new URL(app.hls!.config.workerPath!).pathname,
        legacyGlobals: [
          'Hls',
          'PageReplay',
          'PlayerUpdates',
          'PlayerChrome',
          'PlayerTools',
          'PlayerVideoStream',
        ].filter((name: string) => name in window),
        session: app.pageReplay.session!.session_id,
      };
    });
    assert.equal(
      state.sameInstance,
      true,
      'Re-importing the entry must not open another player or recording session.',
    );
    assert.equal(state.model, true);
    assert.equal(state.version, '1.7.3');
    assert.equal(state.delivery, true);
    assert.equal(state.workerPath, '/static/vendor/hls.worker.js');
    assert.deepEqual(state.legacyGlobals, [], 'Application classes and hls.js must stay in module scope.');
    assert.deepEqual(errors, []);
    assert.deepEqual(failures, []);
    assert.equal(
      scripts.filter((path) => path === '/static/vendor/hls.min.mjs').length,
      1,
      'Shared player imports must load hls.js only once.',
    );
    assert(workers.includes('/static/vendor/hls.worker.js'), 'ESM playback must retain worker transmuxing.');
    assert(
      page.workers().some((worker) => new URL(worker.url()).pathname === '/static/vendor/hls.worker.js'),
      'The media worker must remain active after frames decode.',
    );
    await page.locator('#pause-button').click();
    await page.waitForFunction(() => document.querySelector<HTMLVideoElement>('video')!.paused);
    await page.locator('#pause-button').click();
    await page.waitForFunction(() => !document.querySelector<HTMLVideoElement>('video')!.paused);
    const session = await page.evaluate(
      async () => (await import('/static/player.js')).pageReplay.session!.session_id,
    );
    assert.equal(session, state.session);
    await page.goto('about:blank');
    assert.deepEqual(errors, []);
    console.log(
      `${name}: native ESM graph, JavaScript MIME, shared hls.js import, no application globals, external media worker, streamed playback, pause/resume and single session passed`,
    );
  } finally {
    await browser.close();
  }
}

const results = await Promise.allSettled([run('chromium', chromium), run('webkit', webkit)]);
for (const result of results)
  if (result.status === 'rejected') {
    console.error(result.reason);
    process.exitCode = 1;
  }
