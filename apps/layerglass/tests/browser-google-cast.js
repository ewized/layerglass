import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { installCastFixture } from './cast-fixture.js';
import { waitForPlayer } from './player-page.js';

const base = process.env.VIEWER_URL || 'http://127.0.0.1:8080';
const browser = await chromium.launch({ headless: true, channel: 'chromium', args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
const page = await context.newPage();
const errors = [], messages = [], requests = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => messages.push(message.text()));
page.on('request', request => requests.push(new URL(request.url()).pathname));
let blocked = false, sdkRequests = 0;
await page.route('https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1', route => {
  sdkRequests++;
  return blocked ? route.abort('blockedbyclient') : route.fulfill({ contentType: 'text/javascript',
    body: `(${installCastFixture.toString()})(window);` });
});
await page.addInitScript(() => {
  window.mediaActions = new Map();
  const register = navigator.mediaSession.setActionHandler.bind(navigator.mediaSession);
  navigator.mediaSession.setActionHandler = (name, handler) => {
    register(name, handler);
    if (handler) window.mediaActions.set(name, handler);
    else window.mediaActions.delete(name);
  };
});

try {
  await page.goto(base);
  await waitForPlayer(page, ({ app }) => app.video.readyState >= 3 && !app.video.paused &&
    app.playerMedia.sender.ready && app.pageReplay.session.end_seconds >= 10, undefined, { timeout: 45000 });
  await page.evaluate(async () => {
    const app = window.castApp = await import('/static/player.js');
    window.castOriginal = { video: app.video, decoder: app.hls, source: app.video.currentSrc,
      session: app.pageReplay.session.session_id, updates: app.updates.source, time: app.video.currentTime };
    window.castFixture.range = { start: app.pageReplay.session.start_seconds, end: app.pageReplay.session.end_seconds };
    window.castFixture.holdSession = true;
    app.video.remote.prompt = () => { throw new Error('Google Cast must not prompt the incompatible blob source.'); };
  });
  const initialVideoRequests = requests.filter(path => /\/video$/.test(path)).length;
  const cast = page.getByRole('button', { name: 'Cast', exact: true });
  await page.mouse.move(640, 400); // Wake controls after the ten-second history wait.
  await cast.click();
  assert.equal(await cast.isDisabled(), true);
  assert.equal(await page.evaluate(() => window.castFixture.requests[0].activated), true);
  assert.equal(await page.locator('video').evaluate(video => video.paused), false,
    'Local playback continues while the receiver picker is open.');
  await page.evaluate(() => window.castFixture.cancelSession());
  await waitForPlayer(page, ({ app }) => !app.playerMedia.prompting);
  assert.equal(await cast.isDisabled(), false);
  assert.equal(await page.locator('video').evaluate(video => video.paused), false);
  assert.equal(await page.evaluate(() => window.castFixture.loads.length), 0);

  await page.evaluate(() => { window.castFixture.holdSession = false; });
  await cast.click();
  await waitForPlayer(page, ({ app }) => app.pageReplay.remote && app.playerMedia.remoteActive && app.video.paused);
  assert.equal(await cast.getAttribute('aria-pressed'), 'true');
  assert.equal(await page.evaluate(() => navigator.mediaSession.playbackState), 'playing');
  const load = await page.evaluate(() => {
    const request = window.castFixture.loads[0];
    return { url: request.media.contentId, type: request.media.contentType,
      title: request.media.metadata.title, subtitle: request.media.metadata.subtitle,
      live: request.media.streamType, autoplay: request.autoplay };
  });
  assert.match(load.url, /\/replay\/[a-f0-9]{32}\/live\.m3u8/);
  assert(!load.url.startsWith('blob:'));
  assert.equal(load.live, 'live');
  assert.equal(load.autoplay, true);
  assert.equal(load.title, 'Bambu Lab X2D');
  assert.equal(load.subtitle, '20P000000000001');
  await page.getByRole('button', { name: 'Pause video', exact: true }).click();
  await waitForPlayer(page, ({ app }) => app.pageReplay.paused && navigator.mediaSession.playbackState === 'paused');
  await page.getByRole('button', { name: 'Play buffered video', exact: true }).click();
  await waitForPlayer(page, ({ app }) => !app.pageReplay.paused && navigator.mediaSession.playbackState === 'playing');
  await page.locator('#replay-slider').press('Home');
  assert.equal(await page.evaluate(() => window.castFixture.controls.at(-1).seek), 0);
  assert.equal(await page.evaluate(() => window.castApp.pageReplay.followLive), false);
  await page.evaluate(() => window.mediaActions.get('pause')());
  assert.equal(await page.evaluate(() => window.castApp.pageReplay.paused), true);
  await page.evaluate(() => window.mediaActions.get('play')());
  assert.equal(await page.evaluate(() => window.castApp.pageReplay.paused), false);
  await page.getByRole('button', { name: 'Return to live video', exact: true }).click();
  assert.equal(await page.evaluate(() => window.castApp.pageReplay.followLive), true);
  assert.equal(await page.locator('video').evaluate(video => video.paused), true,
    'Casting controls must operate the receiver while local decoding is paused.');
  assert.equal(requests.filter(path => /\/video$/.test(path)).length, initialVideoRequests,
    'Remote playback/seek controls must not restart the local video endpoint.');

  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  assert.equal(await page.evaluate(() => window.castApp.updates.source === window.castOriginal.updates), true);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
    window.castFixture.disconnect();
  });
  await waitForPlayer(page, ({ app }) => !app.pageReplay.remote && !app.playerMedia.remoteActive &&
    !app.video.paused && app.video.readyState >= 2, undefined, { timeout: 30000 });
  assert.equal(await cast.getAttribute('aria-pressed'), 'false');
  assert.equal(await page.evaluate(() => {
    const app = window.castApp, original = window.castOriginal;
    return app.video === original.video && app.hls === original.decoder && app.video.currentSrc === original.source &&
      app.pageReplay.session.session_id === original.session && !app.video.controls;
  }), true, 'Disconnect restores the same decoder and rewind session.');

  // Exercise actual browser CORS checks from a receiver origin, not a mocked fetch.
  // This synthetic receiver document has no network response address space;
  // explicitly grant its loopback access in Chrome's isolated test profile.
  await context.grantPermissions(['local-network-access'], { origin: 'http://127.0.0.1:8090' });
  const receiver = await context.newPage();
  await receiver.route('http://127.0.0.1:8090/receiver', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Receiver fixture</title>' }));
  await receiver.goto('http://127.0.0.1:8090/receiver');
  const received = await receiver.evaluate(async url => {
    const playlist = await fetch(url);
    const text = await playlist.text();
    const segment = new URL(text.split('\n').find(line => line.startsWith('segment-')), url).href;
    const video = await fetch(segment);
    let apiReadable = false;
    try { await fetch(new URL('/api/cameras', url)); apiReadable = true; } catch (_) {}
    return { playlist: playlist.status, segment: video.status, bytes: (await video.arrayBuffer()).byteLength, apiReadable };
  }, load.url);
  assert.equal(received.playlist, 200);
  assert.equal(received.segment, 200);
  assert(received.bytes > 0);
  assert.equal(received.apiReadable, false);
  await receiver.close();

  blocked = true;
  await page.reload();
  await waitForPlayer(page, ({ app }) => app.video.readyState >= 3 && !app.video.paused &&
    app.playerMedia.sender.state === 'unavailable', undefined, { timeout: 45000 });
  assert.equal(await cast.isDisabled(), true);
  const failedLoads = sdkRequests;
  await page.evaluate(async () => {
    const app = await import('/static/player.js');
    window.sdkRecoveryOriginal = { video: app.video, session: app.pageReplay.session.session_id };
  });
  assert.equal(await page.locator('script[src*="cast_sender.js"]').count(), 0, 'A failed SDK script is removed.');
  blocked = false;
  await page.mouse.move(640, 400);
  await page.locator('#options-button').click();
  await page.locator('#refresh-button').click();
  await waitForPlayer(page, ({ app }) => app.playerMedia.sender.ready && app.video.readyState >= 3 &&
    !app.video.paused, undefined, { timeout: 45000 });
  assert.equal(sdkRequests, failedLoads + 1, 'Explicit Refresh retries the failed SDK once without reloading the page.');
  assert.equal(await page.evaluate(async () => {
    const app = await import('/static/player.js');
    return app.video === window.sdkRecoveryOriginal.video &&
      app.pageReplay.session.session_id === window.sdkRecoveryOriginal.session;
  }), true);
  await page.mouse.move(640, 400);
  await cast.click();
  await waitForPlayer(page, ({ app }) => app.playerMedia.remoteActive);
  assert.equal(await page.evaluate(() => window.castFixture.requests[0].activated), true);
  await page.evaluate(() => window.castFixture.disconnect());
  assert.deepEqual(errors, []);
  assert.equal(messages.some(message => /Content Security Policy/.test(message)), false, 'The SDK must load under the production CSP.');
  console.log('Chromium: native SDK boundary, trusted Cast activation, remote controls, receiver CORS, decoder/history restoration and same-page explicit refresh after SDK failure passed.');
} catch (error) {
  console.error('Google Cast diagnostics', { errors, messages: messages.slice(-12) });
  throw error;
} finally { await browser.close(); }
