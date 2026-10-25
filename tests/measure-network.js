import { chromium, webkit } from 'playwright';

const base = process.env.VIEWER_URL || 'http://192.168.50.50:8099';
const seconds = Number(process.env.MEASURE_SECONDS || 30);

function category(request) {
  const path = new URL(request.url()).pathname;
  if (path === '/api/events') return 'event_stream';
  if (/^\/replay\/[a-f0-9]+\/video$/.test(path)) return 'video_stream';
  if (path === '/api/status') return 'status';
  if (path === '/api/cameras') return 'catalog';
  if (/^\/api\/sessions\/[a-f0-9]+$/.test(path)) return 'replay_metadata';
  if (path.startsWith('/api/sessions')) return 'session_actions';
  if (path.endsWith('.m3u8')) return 'video_playlist';
  if (path.endsWith('.ts')) return 'video_segment';
  if (path.endsWith('.jpg')) return 'jpeg_frame';
  return 'other';
}

(async () => {
  const name = process.env.BROWSER === 'webkit' ? 'webkit' : 'chromium';
  const browser = await (name === 'webkit' ? webkit : chromium).launch({ headless: true,
    args: name === 'chromium' ? ['--no-sandbox'] : [] });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const startup = {};
    const steady = {};
    let measuring = false;
    page.on('request', request => {
      const counts = measuring ? steady : startup;
      const group = category(request);
      counts[group] = (counts[group] || 0) + 1;
    });
    await page.goto(base);
    await page.waitForFunction(() => {
      const v = document.querySelector('video');
      return v.videoWidth > 0 && !v.paused && document.querySelector('#overlay').hidden;
    }, undefined, { timeout: 45000 });
    const started = await page.evaluate(() => document.querySelector('video').currentTime);
    if (process.env.OPEN_STATS === '1') await page.evaluate(async () => {
      const { playerTools } = await import('/static/player.js');
      return (playerTools.showStats(true));
    });
    measuring = true;
    await page.waitForTimeout(seconds * 1000);
    const played = await page.evaluate(() => document.querySelector('video').currentTime);
    const media = await page.evaluate(async () => {
      const { hls, video, videoStream } = await import('/static/player.js');
      return (({
      width: video.videoWidth, height: video.videoHeight,
      continuous: typeof videoStream !== 'undefined' && Boolean(videoStream?.connected),
      cached_bytes: typeof videoStream !== 'undefined' ? videoStream?.bytes ?? null : null,
      codec: typeof hls !== 'undefined' ? hls?.levels?.[0]?.videoCodec ?? null : null,
    }));
    });
    media.worker = page.workers().some(worker => new URL(worker.url()).pathname === '/static/vendor/hls.worker.js');
    console.log(JSON.stringify({ browser: name, seconds, startup, steady,
      video_seconds_played: Math.round((played - started) * 10) / 10, media }));
    await page.goto('about:blank');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
