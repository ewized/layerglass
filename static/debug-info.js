import { printerPlaybackTime } from './printer-history.js';

const finite = value => Number.isFinite(value) ? value : null;
const ranges = value => Array.from({ length: value?.length || 0 }, (_, index) => [value.start(index), value.end(index)]);

export function debugInfo(state, { video, image, player }, view, now = Date.now()) {
  const { camera, printer, printerHistory, replay, hls, videoStream, videoCodec, server, discovery } = state;
  const at = replay?.session ? printerPlaybackTime(video, hls, replay) : null;
  const displayed = replay?.session ? printerHistory?.peek(at) ?? null : printer ?? null;
  const bounds = replay?.bounds() || {};
  const quality = video.getVideoPlaybackQuality?.();
  const jpeg = image && !image.hidden;
  return {
    schema_version: 1,
    application: 'Layerglass',
    generated_at: new Date(now).toISOString(),
    browser: {
      user_agent: view.navigator.userAgent,
      language: view.navigator.language,
      online: view.navigator.onLine,
      secure_context: view.isSecureContext,
      viewport: [player.clientWidth, player.clientHeight],
      pixel_ratio: view.devicePixelRatio,
      visibility: view.document.visibilityState,
    },
    camera: camera ? Object.fromEntries(['id', 'name', 'serial', 'manufacturer', 'provider', 'model', 'host', 'port']
      .filter(key => camera[key] !== undefined).map(key => [key, camera[key]])) : null,
    playback: {
      mode: replay?.paused ? 'paused' : replay?.followLive === false ? 'replay' : 'live',
      position_seconds: finite(replay?.paused ? replay.position : bounds.current ?? video.currentTime),
      displayed_at: Number.isFinite(at) ? new Date(at * 1000).toISOString() : null,
      history_start_seconds: finite(bounds.start), history_end_seconds: finite(bounds.end),
      recorded_printer_available: Boolean(replay?.session && displayed !== null),
      mini_player: player.classList.contains('mini-player'),
      fullscreen: Boolean(view.document.fullscreenElement || view.document.webkitFullscreenElement ||
        player.classList.contains('expanded') || player.classList.contains('native-fullscreen')),
    },
    video: {
      resolution: [jpeg ? image.naturalWidth : video.videoWidth, jpeg ? image.naturalHeight : video.videoHeight],
      decoder: jpeg ? 'Browser JPEG' : 'Browser native',
      codec: jpeg ? 'JPEG' : videoCodec ?? null,
      pipeline: jpeg ? 'Image' : hls ? 'hls.js + MediaSource' : replay?.session?.kind === 'file' ? 'Native video' : 'Native HLS',
      delivery: jpeg ? 'JPEG frames' : videoStream ? 'HTTP stream' : replay?.session?.kind === 'file' ? 'Browser media' : 'HLS',
      stream_connected: videoStream?.connected ?? null,
      current_time: finite(video.currentTime), duration_seconds: finite(video.duration),
      native_live: video.duration === Infinity, paused: video.paused, seeking: video.seeking,
      playback_rate: video.playbackRate, ready_state: video.readyState, network_state: video.networkState,
      frames: finite(quality?.totalVideoFrames ?? video.webkitDecodedFrameCount),
      dropped_frames: finite(quality?.droppedVideoFrames ?? video.webkitDroppedFrameCount),
      buffered: ranges(video.buffered), seekable: ranges(video.seekable),
      media_bit_rate: finite(videoStream?.mediaBitrate),
      bandwidth_estimate: videoStream ? null : finite(hls?.bandwidthEstimate),
      error_code: video.error?.code ?? null,
    },
    previews: state.previewHistory?.diagnostics() ?? null,
    server: server ? Object.fromEntries(['state', 'mode', 'uptime_seconds', 'last_segment_age_seconds', 'restarts']
      .filter(key => server[key] !== undefined).map(key => [key, server[key]])) : null,
    printer: { displayed, live: printer ?? null },
    activity: { discovery: discovery ? Object.fromEntries(['state', 'checked', 'total', 'cached', 'cache_hits', 'started_at', 'finished_at']
      .filter(key => discovery[key] !== undefined).map(key => [key, discovery[key]])) : null },
  };
}

// Start the native write inside the click callback, before any asynchronous
// work. Safari requires that activation. No readings are fetched for a copy.
export function writeDebugClipboard(document, text) {
  const clipboard = document.defaultView.navigator.clipboard;
  if (typeof clipboard?.writeText === 'function') return clipboard.writeText(text);
  const active = document.activeElement;
  const selection = document.getSelection();
  const saved = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : [];
  const input = document.createElement('textarea');
  input.className = 'sr-only';
  input.readOnly = true;
  input.tabIndex = -1;
  input.setAttribute('aria-hidden', 'true');
  input.value = text;
  (document.fullscreenElement || document.webkitFullscreenElement || document.body).append(input);
  try {
    input.focus({ preventScroll: true });
    input.select();
    input.setSelectionRange(0, text.length);
    if (!document.execCommand('copy')) throw new Error('Clipboard unavailable');
  } finally {
    input.remove();
    if (active?.isConnected) active.focus({ preventScroll: true });
    if (selection) {
      selection.removeAllRanges();
      for (const range of saved) selection.addRange(range);
    }
  }
  return Promise.resolve();
}
