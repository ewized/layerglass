import type { Page } from 'playwright';
import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { waitForPlayer } from './player-page.ts';

const base = process.env.VIEWER_URL || 'http://127.0.0.1:8080';
const output = process.env.SCREENSHOT_DIR;
const engines = { chromium, webkit };

async function openMenu(page: Page) {
  await page.locator('#player').click({ button: 'right', position: { x: 4, y: 400 } });
  await page.locator('#video-context-menu').waitFor({ state: 'visible' });
}

async function pastedReport(page: Page) {
  // Paste with a trusted keyboard gesture instead of granting clipboard-read.
  // This exercises the real clipboard in WebKit as well as Chromium.
  await page.evaluate(() => {
    const input = document.createElement('textarea');
    input.id = 'test-paste';
    Object.assign(input.style, {
      position: 'fixed',
      inset: '0',
      width: '80px',
      height: '80px',
      zIndex: '20',
    });
    document.body.append(input);
    input.focus();
  });
  await page.keyboard.press('Control+V');
  await page.waitForFunction(
    () => document.querySelector<HTMLTextAreaElement>('#test-paste')!.value.startsWith('{'),
    undefined,
    { timeout: 8000 },
  );
  const text = await page.locator('#test-paste').inputValue();
  await page.locator('#test-paste').evaluate((input: HTMLElement) => input.remove());
  return JSON.parse(text);
}

for (const [name, engine] of Object.entries(engines)) {
  if (process.env.BROWSER && process.env.BROWSER !== name) continue;
  const browser = await engine.launch({
    headless: true,
    ...(name === 'chromium' ? { channel: 'chromium', args: ['--no-sandbox'] } : {}),
  });
  const page = await browser.newPage({
    viewport: { width: 414, height: 896 },
    isMobile: true,
    hasTouch: true,
    serviceWorkers: 'block',
  });
  const errors: Array<string> = [];
  const copyMessages: Array<string> = [];
  const requests: Array<string> = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (/Debug info copied|Could not copy debug info/.test(message.text())) copyMessages.push(message.text());
  });
  page.on('request', (request) => requests.push(new URL(request.url()).pathname));
  await page.addInitScript(() => {
    const clipboard = navigator.clipboard;
    if (!clipboard?.writeText) return;
    const write = clipboard.writeText.bind(clipboard);
    clipboard.writeText = (text) => {
      window.clipboardAttempt = {
        active: navigator.userActivation?.isActive,
        focused: document.hasFocus(),
        allowed: document.permissionsPolicy?.allowsFeature('clipboard-write'),
      };
      return write(text).catch((error) => {
        window.clipboardAttempt.error = error.message;
        throw error;
      });
    };
  });
  try {
    await page.goto(base);
    await waitForPlayer(
      page,
      ({ app }) =>
        app.video.readyState >= 3 &&
        !app.video.paused &&
        app.video.currentTime > 2 &&
        app.pageReplay.session?.ready,
      undefined,
      { timeout: 45000 },
    );
    assert.equal(await page.evaluate(() => typeof navigator.clipboard?.writeText), 'function');
    await page.evaluate(async () => {
      const app = await import('/static/player.js');
      window.debugOriginal = { decoder: app.hls, session: app.pageReplay.session!.session_id };
      app.playerTools.stats.show(true);
    });
    await page.waitForFunction(() =>
      Number.isFinite(
        parseInt(document.querySelector<HTMLElement>('[data-stat-key="layer"]')?.textContent ?? '', 10),
      ),
    );
    assert((await page.locator('[data-stats-section="printer"] dd').count()) <= 26);
    assert.equal(await page.locator('[data-stat-key^="reported/"]').count(), 0);
    assert.match((await page.locator('[data-stat-key="nozzle_2"]').textContent()!)!, /°C.*°F/);
    await page.evaluate(async () => (await import('/static/player.js')).pageReplay.togglePause());
    await page.waitForFunction(() => document.querySelector<HTMLVideoElement>('video')!.paused);
    await page.waitForTimeout(4000);

    await openMenu(page);
    assert.deepEqual(await page.locator('#video-context-menu [role="menuitem"] span').allTextContents(), [
      'Mini player',
      'Stats for nerds',
      'Copy debug info',
    ]);
    requests.length = 0;
    await page.locator('[data-player-action="copy-debug"]').click();
    await page.waitForFunction(() =>
      ['Copied', 'Try copying again'].includes(
        document.querySelector<HTMLElement>('[data-player-action="copy-debug"] span')!.textContent,
      ),
    );
    assert.equal(
      await page.locator('[data-player-action="copy-debug"] span').textContent(),
      'Copied',
      copyMessages.join('\n'),
    );
    const report = await pastedReport(page);
    assert.equal(report.schema_version, 1);
    assert.equal(report.playback.mode, 'paused');
    assert.equal(report.playback.recorded_printer_available, true);
    assert(report.printer.live.layer >= report.printer.displayed.layer + 3);
    assert.equal(report.printer.live.reported.print.ams.tray[0].tray_type, 'PLA');
    assert.equal(report.printer.live.reported.print.ams.tray[0].enabled, false);
    assert.equal(report.printer.live.reported.print.new_sensor.coefficient, 0.00000321);
    assert(!JSON.stringify(report).includes('fixture-code'));
    assert.equal(
      requests.filter((path) => /\/(?:printer|video)$|\/api\/discover$/.test(path)).length,
      0,
      'Copying must not request more data or restart playback.',
    );
    await page.waitForFunction(
      () =>
        document.querySelector<HTMLElementTagNameMap['printer-context-menu']>('#video-context-menu')!.hidden,
    );
    if (output) await page.screenshot({ path: `${output}/${name}-quick-stats.png` });

    await page.evaluate(async () => (await import('/static/player.js')).playerTools.showStats(false));

    // Older HTTP/LAN pages lack the async Clipboard API. Exercise the real
    // selected-text copy path, including focus restoration and node cleanup.
    await page.evaluate(() =>
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }),
    );
    await openMenu(page);
    await page.locator('[data-player-action="copy-debug"]').click();
    await page.waitForFunction(
      () =>
        document.querySelector<HTMLElement>('[data-player-action="copy-debug"] span')!.textContent ===
        'Copied',
    );
    assert.equal(await page.locator('textarea.sr-only').count(), 0);
    const fallback = await pastedReport(page);
    assert.equal(fallback.printer.live.reported.print.ams.tray[0].tray_type, 'PLA');
    assert.equal(fallback.printer.displayed.layer, report.printer.displayed.layer);
    assert.equal(
      await page.locator('#player-stats').isVisible(),
      false,
      'Copy must work without opening Stats.',
    );
    await page.waitForFunction(
      () =>
        document.querySelector<HTMLElementTagNameMap['printer-context-menu']>('#video-context-menu')!.hidden,
    );

    await page.evaluate(() =>
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: () => Promise.reject(new DOMException('Blocked', 'NotAllowedError')) },
      }),
    );
    await openMenu(page);
    await page.locator('[data-player-action="copy-debug"]').click();
    await page.waitForFunction(
      () =>
        document.querySelector<HTMLElement>('[data-player-action="copy-debug"] span')!.textContent ===
        'Try copying again',
    );
    assert.equal(await page.locator('#video-context-menu').isVisible(), true);
    assert.equal(await page.locator('[data-player-action="copy-debug"] use').getAttribute('href'), '#i-copy');

    // A late clipboard result must not close or relabel a newly opened menu.
    await page.evaluate(() =>
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: () =>
            new Promise<void>((resolve) => {
              window.finishDebugCopy = resolve;
            }),
        },
      }),
    );
    await openMenu(page);
    await page.locator('[data-player-action="copy-debug"]').click();
    await page.keyboard.press('Escape');
    await openMenu(page);
    await page.evaluate(() => window.finishDebugCopy());
    await page.waitForTimeout(1100);
    assert.equal(await page.locator('#video-context-menu').isVisible(), true);
    assert.equal(
      await page.locator('[data-player-action="copy-debug"] span').textContent(),
      'Copy debug info',
    );
    await page.keyboard.press('Escape');

    await page.locator('#options-button').click();
    assert.equal(await page.locator('#player-options [data-player-action="copy-debug"]').count(), 0);
    await page.keyboard.press('Escape');
    assert.equal(
      await page.evaluate(async () => {
        const app = await import('/static/player.js');
        return (
          app.hls === window.debugOriginal.decoder &&
          app.pageReplay.session!.session_id === window.debugOriginal.session &&
          !app.playerTools.nativeMiniMode()
        );
      }),
      true,
      'Copying must preserve the decoder/session and must never enter PiP.',
    );
    assert.deepEqual(errors, []);
    console.log(
      `${name}: compact print diagnostics, real native clipboard/paste, full live/recorded extra fields, legacy HTTP copy, denied/late feedback, and no requests/restarts/PiP passed.`,
    );
  } catch (error) {
    console.error(
      name,
      copyMessages,
      await page.locator('[data-player-action="copy-debug"] span').textContent(),
      await page.evaluate(() => window.clipboardAttempt),
    );
    throw error;
  } finally {
    await browser.close();
  }
}
