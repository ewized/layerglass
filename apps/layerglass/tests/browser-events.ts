import type { BrowserType, Page } from 'playwright';
import { waitForPlayer } from './player-page.ts';
import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';

const base = process.env.VIEWER_URL || 'http://127.0.0.1:8080';
const metadataPoll = (path: string) =>
  path === '/api/status' || path === '/api/cameras' || /^\/api\/sessions\/[a-f0-9]{32}$/.test(path);

async function playing(page: Page) {
  await waitForPlayer(
    page,
    ({ app }) => {
      const { pageReplay } = app;

      const video = document.querySelector<HTMLVideoElement>('video');
      return (
        video!.videoWidth > 0 &&
        !video!.paused &&
        video!.currentTime > 0 &&
        document.querySelector<HTMLElementTagNameMap['printer-loading']>('#overlay')!.hidden &&
        pageReplay.session?.ready
      );
    },
    undefined,
    { timeout: 45000 },
  );
}

async function run(name: string, engine: BrowserType) {
  const browser = await engine.launch({ headless: true, args: name === 'chromium' ? ['--no-sandbox'] : [] });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  const errors: Array<string> = [];
  const requests: Array<string> = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => requests.push(new URL(request.url()).pathname));
  try {
    await page.goto(base);
    await playing(page);
    await waitForPlayer(page, ({ app }) => {
      const { updates } = app;
      return updates.streaming;
    });
    const initial = await page.evaluate(async () => {
      const { pageReplay, updates } = await import('/static/player.js');

      window.eventCounts = { catalog: 0, heartbeat: 0 };
      updates.source!.addEventListener('state', (event) => {
        if (JSON.parse(event.data).catalog) window.eventCounts.catalog++;
      });
      updates.source!.addEventListener('heartbeat', () => window.eventCounts.heartbeat++);
      return {
        video: document.querySelector<HTMLVideoElement>('video')!.currentTime,
        end: pageReplay.session!.end_seconds,
        session: pageReplay.session!.session_id,
      };
    });
    requests.length = 0;
    await page.waitForTimeout(20000);
    const running = await page.evaluate(async () => {
      const { pageReplay } = await import('/static/player.js');
      return {
        video: document.querySelector<HTMLVideoElement>('video')!.currentTime,
        end: pageReplay.session!.end_seconds,
        session: pageReplay.session!.session_id,
        counts: window.eventCounts,
      };
    });
    assert(
      running.video - initial.video >= 15 && running.end - initial.end >= 15,
      'Playback and page recording must continue with pushed metadata.',
    );
    assert.equal(running.session, initial.session);
    assert.deepEqual(
      requests.filter(metadataPoll),
      [],
      'Healthy streaming must make no recurring status, catalog, or replay metadata requests.',
    );
    assert(!requests.includes('/api/snapshot'), 'Healthy SSE must suppress fallback polling.');
    assert(
      !requests.includes('/api/events'),
      'Healthy SSE must retain its connection instead of reopening it.',
    );
    assert(
      !requests.includes('/api/discover'),
      'Loading or watching must never initiate a recurring network scan.',
    );
    assert.equal(running.counts.catalog, 0, 'An unchanged printer list must not be resent periodically.');
    assert(running.counts.heartbeat >= 1, 'The persistent connection needs a heartbeat.');
    await page.mouse.move(10, 10);
    await page.locator('#pause-button').click();
    await page.waitForTimeout(300);
    const paused = await page.locator('video').evaluate((video: HTMLVideoElement) => video.currentTime);
    await context.setOffline(true);
    await page.waitForTimeout(1200);
    await context.setOffline(false);
    await waitForPlayer(page, ({ app }) => {
      const { updates } = app;
      return updates.streaming;
    });
    assert.equal(
      await page.evaluate(async () => {
        const { pageReplay } = await import('/static/player.js');
        return pageReplay.session!.session_id;
      }),
      initial.session,
      'A network reconnection must preserve the page buffer.',
    );
    assert.equal(
      await page.locator('video').evaluate((video: HTMLVideoElement) => video.paused),
      true,
      'Reconnection must respect pause.',
    );
    assert(
      Math.abs(
        (await page.locator('video').evaluate((video: HTMLVideoElement) => video.currentTime)) - paused,
      ) < 0.5,
    );
    assert(requests.includes('/api/events'), 'Restoring the network must reopen the data stream.');
    assert(!requests.includes('/api/cameras'), 'Reconnection must not fetch the printer list separately.');
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { value: true, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    assert.equal(
      await page.evaluate(async () => {
        const { updates } = await import('/static/player.js');
        return updates.source;
      }),
      null,
      'A hidden phone page must release its event connection.',
    );
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { value: false, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitForPlayer(page, ({ app }) => {
      const { updates } = app;
      return updates.streaming;
    });
    assert.equal(
      await page.evaluate(async () => {
        const { pageReplay } = await import('/static/player.js');
        return pageReplay.session!.session_id;
      }),
      initial.session,
    );
    await page.mouse.move(10, 10);
    await page.locator('#live-button').click();
    await playing(page);
    await page.mouse.move(10, 10);
    await page.locator('#options-button').click();
    await page.locator('#printers-button').click();
    const ids = await page
      .locator('#camera-list [data-camera-id]')
      .evaluateAll((rows: HTMLElement[]) => rows.map((row) => row.dataset.cameraId));
    assert.equal(ids.length, 2);
    await page.locator(`[data-camera-id="${ids[1]}"] .printer-access`).click();
    await waitForPlayer(page, ({ app }) => {
      const { pageReplay, status } = app;
      return status?.state === 'live' && pageReplay.session;
    });
    assert.equal(
      await page.evaluate(async () => {
        const { updates } = await import('/static/player.js');
        return updates.session;
      }),
      initial.session,
      'Managing another printer must keep the current replay subscription.',
    );
    await page.keyboard.press('Escape');
    await page.locator(`[data-camera-id="${ids[0]}"] .printer-select`).click();
    await playing(page);
    const selectedSession = await page.evaluate(async () => {
      const { pageReplay } = await import('/static/player.js');
      return pageReplay.session!.session_id;
    });
    assert.equal(selectedSession, initial.session, 'Reopening the current camera must keep its page buffer.');
    const close = await page.request.post(`${base}/api/sessions/${selectedSession}/close`, {
      headers: { 'X-Viewer-Request': '1' },
      data: {},
    });
    assert.equal(close.status(), 200);
    await waitForPlayer(
      page,
      ({ app, arg: old }) => {
        const { pageReplay, updates } = app;
        return pageReplay.session?.ready && pageReplay.session.session_id !== old && updates.streaming;
      },
      selectedSession,
      { timeout: 30000 },
    );
    await playing(page);

    const fallback = await context.newPage();
    const fallbackRequests: Array<string> = [];
    fallback.on('pageerror', (error) => errors.push(error.message));
    fallback.on('request', (request) => fallbackRequests.push(new URL(request.url()).pathname));
    await fallback.addInitScript(() => {
      Object.defineProperty(window, 'EventSource', { value: undefined });
    });
    await fallback.goto(base);
    await playing(fallback);
    assert.equal(
      await fallback.evaluate(async () => {
        const { updates } = await import('/static/player.js');
        return updates.streaming;
      }),
      false,
    );
    const fallbackEnd = await fallback.evaluate(async () => {
      const { pageReplay } = await import('/static/player.js');
      return pageReplay.session!.end_seconds;
    });
    fallbackRequests.length = 0;
    await fallback.waitForTimeout(17000);
    assert.equal(
      fallbackRequests.filter((path) => path === '/api/snapshot').length,
      1,
      'Without SSE, one combined snapshot every 15 seconds replaces the three old poll loops.',
    );
    assert.deepEqual(fallbackRequests.filter(metadataPoll), []);
    assert(!fallbackRequests.includes('/api/discover'));
    assert(
      (await fallback.evaluate(async () => {
        const { pageReplay } = await import('/static/player.js');
        return pageReplay.session!.end_seconds;
      })) >=
        fallbackEnd + 8,
      'Fallback must update the replay buffer.',
    );
    await fallback.goto('about:blank');
    await page.goto('about:blank');
    assert.deepEqual(errors, []);
    console.log(
      `${name}: persistent SSE/heartbeat, zero recurring metadata/list requests, continued recording/playback, network and visibility recovery, pause preservation, camera isolation, expired-session recovery, and 15s combined fallback passed`,
    );
  } catch (error) {
    console.error(
      name,
      await page
        .evaluate(async () => {
          const { pageReplay, status, updates } = await import('/static/player.js');
          return {
            status: typeof status !== 'undefined' ? status?.state : null,
            overlay: document.querySelector<HTMLElement>('#overlay-title')?.textContent,
            updates:
              typeof updates !== 'undefined'
                ? { streaming: updates.streaming, camera: updates.camera, session: updates.session }
                : null,
            replay: typeof pageReplay !== 'undefined' ? pageReplay.session : null,
          };
        })
        .catch(() => null),
    );
    throw error;
  } finally {
    await browser.close();
  }
}

Promise.all([run('chromium', chromium), run('webkit', webkit)]).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
