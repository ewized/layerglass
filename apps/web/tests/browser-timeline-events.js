import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { waitForPlayer } from './player-page.js';

const base = process.env.VIEWER_URL || 'http://127.0.0.1:8080';
const selected = process.env.BROWSER;
for (const [name, engine] of Object.entries({ chromium, webkit })) {
  if (selected && selected !== name) continue;
  const browser = await engine.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const errors = [];
  const historyRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (/\/api\/sessions\/[^/]+\/printer/.test(request.url())) historyRequests.push(request.url());
  });
  try {
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await waitForPlayer(page, ({ app }) => app.pageReplay.session?.ready && app.video.videoWidth > 0 &&
      !app.video.paused && app.pageReplay.bounds().end > 12, null, { timeout: 60000 });
    await page.evaluate(async () => {
      const app = await import('/static/player.js');
      const { timelineTime } = await import('/static/timeline-events.js');
      const replay = app.pageReplay;
      replay.togglePause();
      const samples = [[0.25, 'IDLE'], [0.5, 'PREPARE'], [0.75, 'PAUSE'], [1, 'RUNNING'], [8, 'FINISH']]
        .map(([position, print_state]) => ({ at: timelineTime(replay.session, position), printer: { connection: 'connected', print_state, error: 0 } }));
      app.printerHistory.apply({ session_id: replay.session.session_id, camera_id: replay.session.camera_id,
        from: samples[0].at, until: samples.at(-1).at, samples }, false);
      replay.timeline.fit(); replay.render(); app.playerChrome.show();
      window.markerVideo = app.video;
      window.markerSession = replay.session.session_id;
      window.markerSeeks = [];
      const seek = replay.seek.bind(replay);
      replay.seek = target => { window.markerSeeks.push(target); seek(target); };
    });
    const markers = page.locator('#timeline-events');
    await page.waitForFunction(() => document.querySelectorAll('.timeline-event').length === 2);
    const mainRequests = historyRequests.length;
    await markers.locator('.timeline-event').first().hover();
    assert.equal(await markers.locator('.timeline-event-tooltip > span').textContent(), '3 print events');
    assert.match(await markers.locator('.timeline-event-tooltip time').textContent(), /^−\d+:\d{2}$/);
    assert.equal(await page.evaluate(() => window.markerSeeks.length), 0, 'Hovering must not seek.');
    assert.equal(historyRequests.length, mainRequests, 'Event labels must not fetch printer history.');
    const bounds = await page.evaluate(() => {
      const marker = document.querySelector('.timeline-event').getBoundingClientRect();
      const slider = document.querySelector('#replay-slider').getBoundingClientRect();
      return { overlap: marker.bottom > slider.top, width: marker.width, sliderWidth: slider.width };
    });
    assert.equal(bounds.overlap, false, 'Marker touch targets must not cover the native scrub input.');
    assert.equal(bounds.width, 32);
    assert(bounds.sliderWidth > 300);

    // Native buttons provide touch activation; clustered events expose exact
    // observations without hiding them behind a single arbitrary seek target.
    await markers.locator('.timeline-event').first().tap();
    assert.equal(await markers.locator('[role="menu"]').isVisible(), true);
    assert.equal(await page.evaluate(async () => {
      const chrome = (await import('/static/player.js')).playerChrome;
      const playing = chrome.isPlaying; chrome.isPlaying = () => true;
      try { return chrome.canHide(); } finally { chrome.isPlaying = playing; }
    }), false, 'An open touch event picker keeps the player controls visible.');
    assert.deepEqual(await markers.locator('[role="menuitem"] span').allTextContents(), ['Print started', 'Print paused', 'Print resumed']);
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(() => document.activeElement.querySelector('span')?.textContent), 'Print paused');
    await page.keyboard.press('Enter');
    assert.deepEqual(await page.evaluate(() => window.markerSeeks), [0.75]);
    assert.equal(await markers.locator('[role="menu"]').count(), 0);
    assert.deepEqual(errors, []);
    assert.equal(await page.evaluate(() => document.activeElement.classList.contains('timeline-event')), true);
    await page.keyboard.press('ArrowRight');
    assert.match(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), /^Print finished, −/);
    await page.keyboard.press('Enter');
    assert.deepEqual(await page.evaluate(() => window.markerSeeks), [0.75, 8]);
    assert.equal(await page.evaluate(() => document.querySelector('video') === window.markerVideo), true);
    assert.equal(await page.evaluate(async () => (await import('/static/player.js')).pageReplay.session.session_id === window.markerSession), true);

    await markers.locator('.timeline-event').first().tap();
    await page.keyboard.press('Escape');
    assert.equal(await markers.locator('[role="menu"]').count(), 0);
    assert.equal(await page.evaluate(() => document.activeElement.classList.contains('timeline-event')), true);
    await page.evaluate(() => {
      const events = document.querySelector('#timeline-events');
      const parent = events.parentElement;
      const next = events.nextSibling;
      events.remove(); parent.insertBefore(events, next);
    });
    await markers.locator('.timeline-event').first().tap();
    await markers.locator('[role="menuitem"]').first().tap();
    assert.deepEqual(await page.evaluate(() => window.markerSeeks), [0.75, 8, 0.5],
      'Reconnecting must not duplicate event activation listeners.');

    // Gesture previews keep the existing mapping and commit only on release.
    const slider = page.locator('#replay-slider');
    const track = await slider.boundingBox();
    await page.mouse.move(track.x + track.width * 0.6, track.y + track.height / 2);
    await page.mouse.down();
    await page.mouse.move(track.x + track.width * 0.4, track.y + track.height / 2, { steps: 8 });
    assert.equal(await page.evaluate(() => window.markerSeeks.length), 3);
    await page.mouse.up();
    assert.equal(await page.evaluate(() => window.markerSeeks.length), 4);
    await page.evaluate(async () => {
      const app = await import('/static/player.js');
      app.printerHistory.setSession({ ...app.pageReplay.session, session_id: 'another-page' });
      app.pageReplay.render();
    });
    assert.equal(await markers.locator('.timeline-event').count(), 0, 'A replacement session removes all old markers.');
    assert.deepEqual(errors, []);
    console.log(`${name}: recorded timeline markers, negative-offset labels, touch clusters, keyboard navigation, one seek per activation, unchanged scrub gestures/video/session and no extra history requests passed`);
    await page.goto('about:blank');
  } finally { await browser.close(); }
}
