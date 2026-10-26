// An explicit allowlist keeps camera footage, credentials, metadata and commands
// out of Cache Storage. There is deliberately no runtime caching of other URLs.
export const SHELL_CACHE_PREFIX = 'printer-camera-shell-';
export const SHELL_PATHS = Object.freeze([
  '/', '/manifest.webmanifest',
  '/static/style.css', '/static/bootstrap.js', '/static/player.js', '/static/pwa.js', '/static/pwa-shell.js',
  '/static/components/backend-picker.js',
  '/static/replay.js', '/static/log.js', '/static/refresh.js', '/static/updates.js',
  '/static/video-stream.js', '/static/visibility.js', '/static/preferences.js',
  '/static/player-ui.js', '/static/player-tools.js', '/static/player-media.js',
  '/static/cast-sender.js',
  '/static/timeline-events.js', '/static/components/timeline-events.js',
  '/static/backend/index.js', '/static/backend/config.js', '/static/backend/python.js', '/static/backend/demo.js',
  '/static/backend/direct.js', '/static/direct-stream.js',
  '/static/printer-history.js', '/static/printer-stats.js', '/static/diffusion.js', '/static/debug-info.js',
  '/static/scrub-preview.js', '/static/components/scrub-preview.js',
  '/static/preview-history.js', '/static/preview-storage.js',
  '/static/components/index.js', '/static/components/base.js',
  '/static/components/templates.js', '/static/components/player.js',
  '/static/components/overlays.js', '/static/components/controls.js',
  '/static/components/settings.js',
  '/static/components/backend-list.js', '/static/components/printers.js',
  '/static/components/stats.js',
  '/static/vendor/hls.min.mjs', '/static/vendor/hls.worker.js',
  '/static/icons/icon.svg', '/static/icons/icon-192.png',
  '/static/icons/icon-512.png', '/static/icons/icon-maskable-512.png',
  '/static/icons/apple-touch-icon.png',
]);
const paths = new Set(SHELL_PATHS);

export function shellPath(request, origin) {
  if (request.method !== 'GET' || request.headers.has('Range')) return null;
  const url = new URL(request.url);
  if (url.origin !== origin || url.search || !paths.has(url.pathname)) return null;
  return url.pathname;
}
