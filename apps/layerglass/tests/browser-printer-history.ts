import type { Route } from 'playwright';
import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { waitForPlayer } from './player-page.ts';
import type { PrinterTelemetry } from '../../backend-contracts/src/index.js';

const base = process.env.VIEWER_URL || 'http://127.0.0.1:8080';
const transport = process.env.TRANSPORT || 'stream';
const selected = process.env.BROWSER;

for (const [name, type] of Object.entries({ chromium, webkit })) {
  if (selected && selected !== name) continue;
  const browser = await type.launch({ headless: true });
  const context = await browser.newContext({
    serviceWorkers: 'block',
    viewport: { width: 414, height: 896 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  const errors: Array<string> = [];
  const historyRequests: Array<string> = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (/\/api\/sessions\/[^/]+\/printer/.test(request.url())) historyRequests.push(request.url());
  });
  if (transport === 'hls')
    await page.route('**/replay/*/video*', (route: Route) => route.fulfill({ status: 503, body: '' }));
  const read = () =>
    page.evaluate(async () => {
      const app = await import('/static/player.js');
      const { debugInfo } = await import('/static/debug-info.js');
      const recorded = debugInfo(app.playerTools.readState(), app.playerTools, window).printer.displayed;
      const record = (value: unknown): Record<string, unknown> =>
        value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
      const print = record(recorded?.reported?.print);
      const stat = (label: string) =>
        app.playerTools.stats.querySelector(`[data-stat="${label}"]`)?.textContent;
      return {
        layer: parseInt(stat('Layer')!, 10),
        nozzle: stat('Nozzle 1') ?? stat('Nozzle'),
        nozzle2: stat('Nozzle 2'),
        elapsed: stat('Elapsed Seconds'),
        progress: stat('Progress'),
        nativeLayer: String(print.layer_num),
        humidity: record(print.ams).humidity,
        nativeCounter: record(print.new_sensor).total,
        currentLayer: app.status!.printer!.layer,
        time: app.video.currentTime,
        session: app.pageReplay.session!.session_id,
        paused: app.video.paused,
      };
    });
  const waitLayer = async (predicate: () => boolean) => {
    await page.waitForFunction(predicate, null, { timeout: 15000 });
  };
  try {
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await waitForPlayer(
      page,
      ({ app }) =>
        app.video.readyState >= 2 &&
        !app.video.paused &&
        app.pageReplay.session?.ready &&
        app.video.currentTime > 2,
      null,
      { timeout: 45000 },
    );
    await page.evaluate(async () => {
      const app = await import('/static/player.js');
      window.historyDecoder = app.hls;
      app.playerTools.stats.show(true);
    });
    await waitLayer(() =>
      Number.isFinite(
        parseInt(document.querySelector<HTMLElement>('[data-stat="Layer"]')?.textContent ?? '', 10),
      ),
    );
    const initial = await read();
    if (initial.nozzle2) {
      assert.match(initial.nozzle2, /°C.*°F/);
      assert.match(initial.elapsed!, /1h \d+m \d+s/);
      assert.equal(await page.locator('[data-stat="Active Nozzle"]').textContent(), '1');
      assert.equal(await page.locator('[data-stat="Speed"]').textContent(), '100% · Standard');
      assert.match((await page.locator('[data-stat="Fans"]').textContent()!)!, /Aux 0%/);
      assert.match((await page.locator('[data-stat="Chamber"]').textContent()!)!, /^34 \/ 0 °C/);
    }
    assert.equal(initial.nativeLayer, String(initial.layer));
    assert.equal(
      await page.locator('[data-stats-section="printer"] [data-stat-key^="reported/"]').count(),
      0,
    );
    assert((await page.locator('[data-stats-section="printer"] dd').count()) <= 26);
    if (process.env.SCREENSHOT_DIR) {
      await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/history-${name}.png` });
    }
    await page.waitForTimeout(9000);
    const running = await read();
    assert(running.layer >= initial.layer + 5, 'Printer readings must advance with the playing video.');
    await page.evaluate(async () => (await import('/static/player.js')).pageReplay.togglePause());
    await page.waitForFunction(
      () =>
        document.querySelector<HTMLVideoElement>('video')!.paused &&
        !document.querySelector<HTMLVideoElement>('video')!.seeking,
    );
    await page.waitForTimeout(1100);
    const paused = await read();
    await page.waitForTimeout(4000);
    const held = await read();
    assert(
      held.currentLayer! >= paused.currentLayer! + 3,
      'The printer must keep reporting while the video is paused.',
    );
    assert.equal(held.layer, paused.layer, 'Paused video must hold its recorded printer reading.');
    assert.equal(held.nozzle, paused.nozzle);
    assert.equal(held.progress, paused.progress);
    assert.equal(held.elapsed, paused.elapsed, 'Elapsed print time must freeze with the recorded video.');
    assert.equal(held.nozzle2, paused.nozzle2);
    assert.equal(held.humidity, paused.humidity);
    assert.equal(
      held.nativeCounter,
      paused.nativeCounter,
      'Unknown nested readings must freeze with the video too.',
    );

    await page.evaluate(async () => {
      const app = await import('/static/player.js');
      app.printerHistory.windows.clear(); // Simulate an uncached history window after backgrounding.
      app.pageReplay.seek(Math.max(app.pageReplay.bounds().start + 0.5, app.video.currentTime - 6));
    });
    await page.waitForFunction(
      (layer) => {
        const value = parseInt(
          document.querySelector<HTMLElement>('[data-stat="Layer"]')?.textContent ?? '',
          10,
        );
        return Number.isFinite(value) && value <= layer - 3;
      },
      paused.layer,
      { timeout: 15000 },
    );
    const rewound = await read();
    assert.notEqual(
      rewound.nativeCounter,
      paused.nativeCounter,
      'Rewind must restore native reported fields.',
    );
    if (initial.nozzle2) {
      assert.notEqual(rewound.elapsed, paused.elapsed, 'Rewinding must restore the old elapsed time.');
      assert.notEqual(rewound.nozzle2, paused.nozzle2);
    }
    assert(
      rewound.layer < held.currentLayer! - 5,
      'Rewind must show historical data instead of the latest MQTT status.',
    );
    assert(historyRequests.length >= 1, 'An uncached seek must fetch a bounded history window.');
    const requests = historyRequests.length;
    await page.evaluate(async () => (await import('/static/player.js')).pageReplay.togglePause());
    await page.waitForTimeout(4000);
    const replaying = await read();
    assert(
      replaying.layer >= rewound.layer + 2,
      'Historical readings must play forward with archived footage.',
    );
    assert.equal(
      historyRequests.length,
      requests,
      'Playing or sampling stats must not poll the history endpoint.',
    );
    await page.evaluate(async () => (await import('/static/player.js')).pageReplay.goLive());
    await page.waitForFunction(
      (layer) =>
        parseInt(document.querySelector<HTMLElement>('[data-stat="Layer"]')?.textContent ?? '', 10) >=
        layer + 2,
      paused.layer,
      { timeout: 15000 },
    );
    const live = await read();
    assert(live.currentLayer! - live.layer < 12, 'Live readings should match the live video latency.');
    assert.equal(live.session, initial.session);
    assert.equal(
      await page.evaluate(async () => (await import('/static/player.js')).hls === window.historyDecoder),
      true,
    );
    assert.equal(
      await page.evaluate(async () => Boolean((await import('/static/player.js')).videoStream)),
      transport === 'stream',
    );
    assert.deepEqual(errors, []);
    // Switching to a single-nozzle printer removes unsupported rows and keeps
    // the order stable; no stale values from the prior printer can remain.
    await page.evaluate(async () => {
      const app = await import('/static/player.js');
      const stats = app.playerTools.stats;
      const original = stats.readState;
      const legacyState = (printer: PrinterTelemetry) => {
        const state = { ...original!(), printer };
        // This negative compatibility fixture deliberately removes its history provider.
        Reflect.set(state, 'printerHistory', null);
        return state;
      };
      try {
        stats.readState = () =>
          legacyState({ nozzle_count: 2, nozzle: 999, nozzle_target: 999, nozzle_2: 30, nozzle_2_target: 0 });
        stats.renderStats();
        if (stats.querySelector<HTMLElement>('[data-stat="Nozzle 1"]')!.textContent !== '—') {
          throw new Error(
            'A dual-nozzle printer must not substitute its active nozzle for an unknown primary reading.',
          );
        }
        stats.readState = () => legacyState({ nozzle: 210, nozzle_target: 215 });
        stats.renderStats();
        if (
          !stats.querySelector<HTMLElement>('[data-stat="Nozzle"]') ||
          stats.querySelector<HTMLElement>('[data-stat="Nozzle 2"]') ||
          stats.querySelector<HTMLElement>('[data-stat="Nozzle 1"]') ||
          stats.querySelector<HTMLElement>('[data-stat="Fans"]')
        ) {
          throw new Error('Changing printer capabilities left stale stats rows.');
        }
        stats.readState = () =>
          legacyState({
            job: '<img src=x onerror=alert(1)>',
            fan_speed: 1,
            fanSpeed: 2,
            reported: { print: { new_metric: 123 } },
          });
        stats.renderStats();
        const first = stats.querySelector<HTMLElement>('[data-stat-key="job"]');
        if (
          stats.querySelector<HTMLElement>(
            '[data-stat-key="fan_speed"], [data-stat-key="fanSpeed"], [data-stat-key^="reported/"]',
          )
        )
          throw new Error('Extra stats leaked into the quick panel.');
        if (
          first!.textContent !== '<img src=x onerror=alert(1)>' ||
          stats.querySelector<HTMLImageElement>('[data-stats-section="printer"] img')
        )
          throw new Error('A stat value was interpreted as HTML.');
        stats.renderStats();
        if (stats.querySelector<HTMLElement>('[data-stat-key="job"]') !== first)
          throw new Error('Unchanged stats replaced their DOM nodes.');
      } finally {
        stats.readState = original;
        stats.renderStats();
      }
    });
    console.log(
      `${name}/${transport}: video-aligned readings, frozen paused stats, old rewind, forward replay, Live, one-window fetch without polling, and unchanged decoder/session passed`,
    );
  } catch (error) {
    console.error(name, transport, await read().catch(() => null));
    throw error;
  } finally {
    await browser.close();
  }
}
