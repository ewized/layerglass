import type { BrowserType } from 'playwright';
import { waitForPlayer } from './player-page.ts';
import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';

const base = process.env.VIEWER_URL || 'http://127.0.0.1:8080';

async function run(name: string, engine: BrowserType) {
  const browser = await engine.launch({ headless: true, args: name === 'chromium' ? ['--no-sandbox'] : [] });
  let debugPage;
  try {
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });
    debugPage = page;
    const errors: Array<string> = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(base);
    await page.waitForFunction(
      () =>
        document.querySelector<HTMLVideoElement>('video')!.videoWidth > 0 &&
        document.querySelector<HTMLElementTagNameMap['printer-loading']>('#overlay')!.hidden,
      undefined,
      { timeout: 45000 },
    );
    assert.equal(
      await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('button, input, select, header, [role="dialog"]')].every(
          (node) => node.closest('#player'),
        ),
      ),
      true,
      'Every control must be inside the player.',
    );
    assert.equal(
      await page
        .locator('.player-header')
        .evaluate(
          (header: HTMLElement) =>
            header.children.length === 2 &&
            header.firstElementChild!.id === 'camera-name' &&
            header.lastElementChild!.id === 'camera-id' &&
            !header.querySelector<HTMLElement>('button, input, select, [role="status"]'),
        ),
      true,
      'Only the printer model and ID belong in the header.',
    );
    assert.equal(
      await page.evaluate(() =>
        ['pause-button', 'live-button', 'status-pill', 'options-button', 'fullscreen-button'].every((id) =>
          document.getElementById(id)!.closest('#player-toolbar'),
        ),
      ),
      true,
      'All playback controls and status belong in the bottom toolbar.',
    );
    assert.equal(
      await page
        .locator('#camera-list')
        .evaluate((list: HTMLElementTagNameMap['printer-list']) => !!list.closest('#player-options')),
      true,
      'Printer selection belongs in Settings.',
    );
    await page.waitForFunction(
      () =>
        document
          .querySelector<HTMLElementTagNameMap['printer-player']>('#player')!
          .classList.contains('controls-hidden'),
      undefined,
      { timeout: 7000 },
    );
    await page.locator('video').tap();
    await page.waitForFunction(
      () =>
        !document
          .querySelector<HTMLElementTagNameMap['printer-player']>('#player')!
          .classList.contains('controls-hidden'),
    );
    await page.getByRole('button', { name: 'Pause video', exact: true }).click();
    await page.waitForFunction(() => document.querySelector<HTMLVideoElement>('video')!.paused);
    // The controls must remain available while paused, even after the idle delay.
    await page.waitForTimeout(3500);
    assert.equal(
      await page
        .locator('#player')
        .evaluate((node: HTMLElementTagNameMap['printer-player']) =>
          node.classList.contains('controls-hidden'),
        ),
      false,
    );
    await page.waitForFunction(
      () => document.querySelector<HTMLElement>('#status-label')!.textContent === 'Paused',
    );
    assert.equal(
      await page.locator('#status-pill').evaluate((node: HTMLElement) => getComputedStyle(node).clipPath),
      'inset(50%)',
      'Playback status must remain accessible without a duplicate visible Paused/Replay label.',
    );
    await page.waitForFunction(() => !document.querySelector<HTMLElement>('#replay-time')!.hidden);
    const replayLayout = await page.evaluate(() => {
      const live = document.querySelector<HTMLButtonElement>('#live-button')!.getBoundingClientRect();
      const timer = document.querySelector<HTMLElement>('#replay-time')!.getBoundingClientRect();
      return {
        gray: !document.querySelector<HTMLButtonElement>('#live-button')!.classList.contains('at-live'),
        gap: timer.left - live.right,
        aligned: Math.abs(timer.top + timer.height / 2 - live.top - live.height / 2),
      };
    });
    assert.equal(replayLayout.gray, true, 'Live must turn gray when watching the past.');
    assert(
      replayLayout.gap >= 0 && replayLayout.gap <= 10 && replayLayout.aligned < 1,
      'The replay timer must sit immediately to the right of the gray Live button on the same line.',
    );
    if (process.env.SCREENSHOT_DIR)
      await page.screenshot({
        path: `${process.env.SCREENSHOT_DIR}/player-${name}-replay.png`,
        fullPage: true,
      });
    await page.getByRole('button', { name: 'Play buffered video', exact: true }).click();
    await page.waitForFunction(
      () => document.querySelector<HTMLElement>('#status-label')!.textContent === 'Replay',
    );
    await page.mouse.move(20, 20);
    await page.getByRole('button', { name: 'Return to live video', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector<HTMLVideoElement>('video')!.paused);
    await page.waitForFunction(() =>
      document.querySelector<HTMLElement>('#status-pill')!.classList.contains('live'),
    );
    assert.equal(
      await page
        .locator('#live-button')
        .evaluate((node: HTMLButtonElement) => node.classList.contains('at-live')),
      true,
    );
    assert.equal(
      await page.locator('#replay-time').evaluate((node: HTMLElement) => node.hidden),
      true,
      'Live playback must hide the timer.',
    );
    await page.waitForFunction(
      () =>
        document
          .querySelector<HTMLElementTagNameMap['printer-player']>('#player')!
          .classList.contains('controls-hidden'),
      undefined,
      { timeout: 7000 },
    );
    await page.mouse.move(20, 20);
    await page.waitForFunction(
      () =>
        !document
          .querySelector<HTMLElementTagNameMap['printer-player']>('#player')!
          .classList.contains('controls-hidden'),
    );
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('dialog', { name: 'Settings' }).waitFor({ state: 'visible' });
    assert.equal(await page.locator('#options-button').getAttribute('aria-expanded'), 'true');
    await page.waitForTimeout(3500);
    assert.equal(
      await page
        .locator('#player')
        .evaluate((node: HTMLElementTagNameMap['printer-player']) =>
          node.classList.contains('controls-hidden'),
        ),
      false,
    );
    for (const viewport of [
      { width: 320, height: 568 },
      { width: 844, height: 390 },
      { width: 1280, height: 960 },
      { width: 390, height: 844 },
    ]) {
      // A landscape viewport now intentionally enters fullscreen. Chromium
      // requires the previous fullscreen window to be restored before resizing.
      await page.evaluate(async () => {
        const { playerFullscreen } = await import('/static/player.js');
        return playerFullscreen.exit();
      });
      await waitForPlayer(page, ({ app }) => {
        const { playerFullscreen } = app;
        return !playerFullscreen.active() && !playerFullscreen.entering;
      });
      await page.setViewportSize(viewport);
      await waitForPlayer(page, ({ app }) => {
        const { playerFullscreen } = app;
        return !playerFullscreen.entering;
      });
      const geometry = await page.evaluate(() => {
        const player = document
          .querySelector<HTMLElementTagNameMap['printer-player']>('#player')!
          .getBoundingClientRect();
        const panel = document
          .querySelector<HTMLElementTagNameMap['printer-settings']>('#player-options')!
          .getBoundingClientRect();
        const toolbar = document.querySelector<HTMLElement>('#player-toolbar')!.getBoundingClientRect();
        const options = document.querySelector<HTMLButtonElement>('#options-button')!.getBoundingClientRect();
        const pause = document.querySelector<HTMLButtonElement>('#pause-button')!.getBoundingClientRect();
        const live = document.querySelector<HTMLButtonElement>('#live-button')!.getBoundingClientRect();
        return {
          width: innerWidth,
          height: innerHeight,
          player: { x: player.x, y: player.y, width: player.width, height: player.height },
          panel: { x: panel.x, y: panel.y, right: panel.right, bottom: panel.bottom },
          toolbar: { x: toolbar.x, y: toolbar.y, right: toolbar.right, bottom: toolbar.bottom },
          optionsTop: options.top,
          liveOnLeft: live.left >= pause.right && live.left - pause.right <= 10,
          buttons: [...document.querySelectorAll<HTMLButtonElement>('#player-toolbar button')].map(
            (button) => {
              const rect = button.getBoundingClientRect();
              return {
                x: rect.x,
                y: rect.y,
                right: rect.right,
                bottom: rect.bottom,
                width: rect.width,
                height: rect.height,
              };
            },
          ),
          overflow:
            document.documentElement.scrollWidth > innerWidth ||
            document.documentElement.scrollHeight > innerHeight,
        };
      });
      assert.equal(geometry.player.x, 0);
      assert.equal(geometry.player.y, 0);
      assert(
        Math.abs(geometry.player.width - viewport.width) < 1 &&
          Math.abs(geometry.player.height - viewport.height) < 1,
      );
      assert.equal(geometry.overflow, false);
      assert.equal(
        geometry.liveOnLeft,
        true,
        'Live must stay on the left beside the pause control at every viewport.',
      );
      assert(
        geometry.panel.x >= 0 &&
          geometry.panel.y >= 0 &&
          geometry.panel.right <= geometry.width &&
          geometry.panel.bottom <= geometry.height,
        'Options must stay within the player in portrait and landscape.',
      );
      assert(
        geometry.panel.bottom <= geometry.optionsTop - 4,
        'The menu must open above the bottom toolbar.',
      );
      assert(
        geometry.toolbar.y >= geometry.height - 150 && geometry.toolbar.bottom <= geometry.height,
        'Controls must stay at the bottom of the player.',
      );
      assert(
        geometry.buttons.every(
          (button) =>
            button.x >= 0 &&
            button.right <= geometry.width &&
            button.y >= geometry.toolbar.y &&
            button.bottom <= geometry.toolbar.bottom + 1 &&
            button.width >= 44 &&
            button.height >= 44,
        ),
        'Toolbar controls must fit and retain 44px touch targets.',
      );
    }
    if (process.env.SCREENSHOT_DIR)
      await page.screenshot({
        path: `${process.env.SCREENSHOT_DIR}/player-${name}-options.png`,
        fullPage: true,
      });
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('dialog', { name: 'Settings' }).isVisible(), false);
    assert.equal(await page.locator('#options-button').getAttribute('aria-expanded'), 'false');
    await page.locator('#player').focus();
    await page.keyboard.press('Tab');
    assert.equal(
      await page
        .locator('#player')
        .evaluate((node: HTMLElementTagNameMap['printer-player']) =>
          node.classList.contains('controls-hidden'),
        ),
      false,
      'Keyboard focus must reveal the controls.',
    );
    if (name === 'chromium') {
      await page.locator('#fullscreen-button').click();
      await page.waitForFunction(() => document.fullscreenElement?.id === 'player');
      await page.evaluate(() => document.exitFullscreen());
    }
    if (process.env.SCREENSHOT_DIR) {
      await page.mouse.move(20, 20);
      await page.screenshot({
        path: `${process.env.SCREENSHOT_DIR}/player-${name}-mobile.png`,
        fullPage: true,
      });
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.screenshot({
        path: `${process.env.SCREENSHOT_DIR}/player-${name}-desktop.png`,
        fullPage: true,
      });
    }
    assert.deepEqual(errors, []);
    await page.goto('about:blank');
    console.log(
      `${name}: model/ID header, left green/gray Live with inline replay timer, no duplicate status, bottom toolbar/menu, upward options, full viewport, auto-hide, touch/mouse wake, pause/replay/Live, keyboard, portrait/landscape${name === 'chromium' ? ', fullscreen' : ''} passed`,
    );
  } catch (error) {
    if (debugPage && !debugPage.isClosed()) {
      console.error(
        name,
        await debugPage.evaluate(() => ({
          player: document.querySelector<HTMLElementTagNameMap['printer-player']>('#player')!.className,
          overlayHidden: document.querySelector<HTMLElementTagNameMap['printer-loading']>('#overlay')!.hidden,
          paused: document.querySelector<HTMLVideoElement>('video')!.paused,
          focused: document.activeElement?.id,
          focusVisible: document.activeElement?.matches(':focus-visible'),
          optionsHidden:
            document.querySelector<HTMLElementTagNameMap['printer-settings']>('#player-options')!.hidden,
        })),
      );
      if (process.env.SCREENSHOT_DIR)
        await debugPage.screenshot({
          path: `${process.env.SCREENSHOT_DIR}/player-${name}-failure.png`,
          fullPage: true,
        });
    }
    throw error;
  } finally {
    await browser.close();
  }
}

Promise.all([run('chromium', chromium), run('webkit', webkit)]).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
