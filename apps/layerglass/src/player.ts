import { errorName, errorMessage, isRecord } from '../../backend-contracts/src/index.js';
import type {
  BackendSnapshot,
  CameraCatalog,
  StreamStatus,
  DiscoveryInfo,
} from '../../backend-contracts/src/index.js';
import { playerElement } from './dom.js';
import type { PlayerElements } from './dom.js';
import { cancelTimeout } from '../../backend-contracts/src/index.js';
import { isFiniteNumber } from '../../backend-contracts/src/index.js';
import './components/index.js';
import './pwa.js';
import Hls from './vendor/hls.min.mjs';
import { PlayerLog } from './log.js';
import { PageReplay } from './replay.js';
import { PlayerFullscreen } from './player-ui.js';
import { PlayerTools } from './player-tools.js';
import { PlayerMedia } from './player-media.js';
import { PlayerPullRefresh, PlayerReload } from './refresh.js';
import { PlayerUpdates } from './updates.js';
import { PlayerVideoStream } from './video-stream.js';
import { playerVisible } from './visibility.js';
import { readCamera, writeCamera } from './preferences.js';
import { PrinterHistory } from './printer-history.js';
import { PrinterTimelineEvents } from './timeline-events.js';
import { PreviewHistory, PreviewCapture } from './preview-history.js';
import { DirectMjpegStream } from './direct-stream.js';
import {
  backend as selectedBackend,
  backendConfig,
  configuration,
  PythonBackend,
  probeDirectPrinter,
  directBrowserError,
  saveBackend,
} from './backend/index.js';

if (!selectedBackend || !configuration) throw new Error('Choose a backend before loading the player');
const backend = selectedBackend;
const player = playerElement(document, 'player');
const $ = <K extends keyof PlayerElements>(id: K): PlayerElements[K] => playerElement(document, id);
const video = $('video');
video.crossOrigin = 'anonymous';
const jpeg = $('jpeg');
jpeg.crossOrigin = 'anonymous';
const viewer = $('viewer');
const overlay = $('overlay');
const statusPill = $('status-pill');
const statusLabel = $('status-label');
const streamMessage = $('stream-message');
const refreshButton = $('refresh-button');
const playButton = $('play-button');
const cameraList = $('camera-list');
const reloadIntent = PlayerReload.consume();
let reloadAutoplay = Boolean(reloadIntent?.autoplay);
let hls: Hls | null = null;
let videoCodec: string | null = null;
let videoStream: PlayerVideoStream | null = null;
let streamFallback = false;
let streamRetryTimer: ReturnType<typeof setTimeout> | null = null;
let streamRetryAttempts = 0;
let streamProbe: PlayerVideoStream | null = null;
let streamProbeAbort: AbortController | null = null;
let loadingSuspended = false;
let pageHidden = false;
let status: StreamStatus | null = null;
let catalog: CameraCatalog | null = null;
let selectedCamera: string | null = null;
let attachedGeneration: string | number | null = null;
let lastFrameAt = 0;
let lastDecodedFrames: number | null = null;
let lastAttachAt = 0;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let jpegTimer: ReturnType<typeof setTimeout> | null = null;
let directStream: DirectMjpegStream | null = null;
let directRetryAttempts = 0;
let polling = false;
let selectionVersion = 0;
let restartDeadline = 0;
let restartRequest = false;
let refreshingViewer = false;
let restartingGeneration: string | number | null = null;
let scanPending = false;
let settingUp = false;
let resumeAfterOffline = false;
const timelineEvents = new PrinterTimelineEvents();
const printerHistory = new PrinterHistory(() => playerTools.stats.renderStats(), {
  fetcher: backend.fetch.bind(backend),
  onSession: (session) => timelineEvents.setSession(session),
  onSamples: (payload) => timelineEvents.apply(payload),
});
const pageReplay = new PageReplay(
  video,
  jpeg,
  () => hls?.liveSyncPosition ?? undefined,
  (session) => {
    printerHistory.setSession(session);
    previewCapture.reset();
    previewHistory.setSession(session);
    $('scrub-preview').reset();
    updates.subscribe(selectedCamera, session?.session_id);
  },
  backend,
);
const previewHistory = new PreviewHistory();
const previewCapture = new PreviewCapture(previewHistory, video, jpeg, () => pageReplay);
const updates = new PlayerUpdates(applyUpdates, updatesUnavailable, backend);
const playerChrome = $('player');
playerChrome.classList.toggle('live-only', Boolean(backend.capabilities.liveOnly));
$('scrub-preview').configure(() => pageReplay, previewHistory, previewCapture);
$('timeline-events').configure(() => pageReplay, timelineEvents);
playerChrome.configure({
  isPlaying: () =>
    Boolean(overlay.hidden) && (jpeg.hidden && !pageReplay.remote ? !video.paused : !pageReplay.paused),
  togglePause: () => pageReplay.togglePause(),
});
const playerFullscreen = new PlayerFullscreen(
  $('player'),
  video,
  () => Boolean(overlay.hidden),
  () => playerChrome.show(),
);
const playerTools = new PlayerTools($('player'), video, jpeg, playerChrome, playerFullscreen, () => ({
  camera: catalog?.cameras.find((item) => item.id === selectedCamera),
  printer: status?.printer,
  server: status,
  printerHistory,
  previewHistory,
  discovery: catalog?.discovery,
  replay: pageReplay,
  hls,
  videoStream,
  videoCodec,
}));
const playerMedia = new PlayerMedia(player, video, pageReplay, {
  backend,
  play,
  mini: () => {
    if (!playerTools.nativeMiniMode()) playerTools.toggleMini();
  },
  remoteChanged: (active) => {
    if (active) {
      cancelTimeout(refreshTimer);
      refreshTimer = null;
      cancelStreamRetry();
    }
    // Restore local decoding if Safari kept the network HLS alternative after
    // AirPlay. A cancelled picker with the original blob needs no reattachment.
    else if (
      playerMedia.webkitPicker &&
      hls &&
      video.currentSrc &&
      !video.currentSrc.startsWith('blob:') &&
      attachedGeneration &&
      status?.state === 'live'
    )
      attachPlayer(null, true);
  },
});
selectedCamera = readCamera();
if (reloadIntent?.cameraId) selectedCamera = reloadIntent.cameraId;
const playerPullRefresh = new PlayerPullRefresh($('player'), () => PlayerReload.reload(selectedCamera));

const backendList = $('backend-list');
$('selected-backend').textContent = backendList.configure(configuration, directBrowserError());
$('local-media-label').hidden = !backend.capabilities.localMedia;
backendList.addEventListener('backend-save', async (event) => {
  if (backendList.busy) return;
  const document = backendList.ownerDocument;
  const focusOwner = backendList.form.contains(document.activeElement)
    ? { input: backendList.input, form: backendList.form, editor: backendList.editing, moved: false }
    : null;
  const focusListeners = new AbortController();
  let failed = false;
  backendList.error = '';
  backendList.busy = true;
  if (focusOwner) {
    const moved = (event: Event) => {
      if (
        event.type === 'keydown'
          ? (event as KeyboardEvent).key === 'Tab'
          : !focusOwner.form.contains(event.target instanceof Node ? event.target : null)
      )
        focusOwner.moved = true;
    };
    for (const type of ['focusin', 'pointerdown', 'keydown'])
      document.addEventListener(type, moved, { capture: true, signal: focusListeners.signal });
  }
  try {
    const config = backendConfig(event.detail);
    if (config.type === 'python') {
      const candidate = new PythonBackend(config.url);
      const response = await candidate.fetch('/api/backend', {
        signal: AbortSignal.timeout(6000),
        cache: 'no-store',
      });
      const description = await response.json();
      if (!response.ok || description.id !== 'python' || description.protocol_version !== 1)
        throw new Error('This address is not a compatible LayerGlass backend.');
    }
    if (config.type === 'direct') await probeDirectPrinter(config.url, { profile: config.profile });
    saveBackend(config);
    const next = new URL(location.href);
    next.searchParams.delete('backend');
    if (next.href === location.href) location.reload();
    else location.assign(next.href);
  } catch (failure) {
    failed = true;
    backendList.error = ['TimeoutError', 'AbortError'].includes(errorName(failure))
      ? 'Connection timed out. Check the address and try again.'
      : failure instanceof TypeError && /fetch|network|load/i.test(failure.message)
        ? 'Cannot reach this backend. Check HTTPS, the allowed frontend origin, and your network permission.'
        : failure instanceof SyntaxError
          ? 'This address is not a compatible LayerGlass backend.'
          : errorMessage(failure);
    console.warn('[LayerGlass] Backend selection failed', errorName(failure));
  } finally {
    focusListeners.abort();
    if (failed) {
      backendList.busy = false;
      if (
        focusOwner &&
        !focusOwner.moved &&
        !document.hidden &&
        document.hasFocus() &&
        [document.body, document.documentElement].some((element) => element === document.activeElement) &&
        backendList.isConnected &&
        backendList.ownerDocument === document &&
        backendList.form === focusOwner.form &&
        backendList.input === focusOwner.input &&
        backendList.editing === focusOwner.editor &&
        backendList.contains(focusOwner.form) &&
        focusOwner.form.contains(focusOwner.input) &&
        !focusOwner.form.hidden &&
        !playerChrome.panel.hidden &&
        playerChrome.settings.page === 'backends' &&
        focusOwner.input.getClientRects().length
      )
        focusOwner.input.focus({ preventScroll: true });
    }
  }
});
$('local-media').addEventListener('change', async () => {
  const file = $('local-media').files?.[0];
  if (!file || !backend.capabilities.localMedia) return;
  backend.setLocalMedia?.(file);
  selectionVersion++;
  pageReplay.close();
  detachPlayer();
  status = null;
  await loadCatalog();
  await loadStatus();
});
video.addEventListener('loadedmetadata', () => {
  backend.setDuration?.(video.duration);
  if (!hls) pageReplay.restoreNativePosition();
  // A demo can already have retained footage. Start this native file at its
  // simulated live edge instead of labelling the first historical frame Live.
  if (pageReplay.session?.kind === 'file' && pageReplay.followLive) pageReplay.goLive();
});

function waiting(title: string, detail: string, spinning = true) {
  if (!networkAvailable()) {
    title = 'Offline';
    detail = 'Connect to your network to view your printer camera.';
    spinning = false;
  }
  PlayerLog.changed('info', 'Viewer', { state: title, detail });
  playerChrome.show();
  viewer.waiting(title, detail, spinning);
}

function networkAvailable() {
  return backend.id === 'demo' || navigator.onLine;
}

function markFrame() {
  if (!networkAvailable()) return;
  // A decoded poster frame does not mean autoplay was allowed.
  if (!video.hidden && video.paused && !playButton.hidden) return;
  const wasWaiting = !overlay.hidden;
  lastFrameAt = Date.now();
  if (wasWaiting) {
    viewer.markFrame();
    playerChrome.show();
    PlayerLog.changed('info', 'Viewer', { state: 'Playing', camera: selectedCamera });
    renderStatus();
  }
}

function sampleVideoProgress() {
  if (video.hidden || status?.state !== 'live' || video.readyState < 2) return;
  const frames = video.getVideoPlaybackQuality?.().totalVideoFrames ?? video.webkitDecodedFrameCount;
  if (isFiniteNumber(frames)) {
    if (!frames || frames === lastDecodedFrames) return;
    lastDecodedFrames = frames;
  }
  markFrame();
}
// Native video owns frame rendering. The stall watchdog only needs periodic
// progress samples, rather than a JavaScript callback on every decoded frame.
for (const event of ['timeupdate', 'loadeddata', 'playing'])
  video.addEventListener(event, sampleVideoProgress);
jpeg.addEventListener('load', () => {
  if (!jpeg.hidden && status?.state === 'live') markFrame();
});

async function play() {
  if (!networkAvailable()) return;
  try {
    if (reloadAutoplay) {
      video.muted = true;
      video.playsInline = true;
    }
    await video.play();
    reloadAutoplay = false;
    playButton.hidden = true;
  } catch (error) {
    if (errorName(error) === 'NotAllowedError') {
      console.info('[LayerGlass] Playback needs a tap');
      reloadAutoplay = false;
      waiting('Ready to play', 'Tap below to start the live view.', false);
      playButton.hidden = false;
    } else console.debug('[LayerGlass] Playback attempt interrupted', errorName(error));
  }
}

function scheduleRefresh(delay = 3000) {
  if (refreshTimer || playerMedia.remoteActive) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    if (navigator.onLine && status?.state === 'live') attachPlayer(null, true);
  }, delay);
}

function canStream() {
  return (
    PlayerVideoStream.supported(pageReplay.session) &&
    (!playerMedia.webkitPicker || typeof window.ManagedMediaSource === 'function')
  );
}

function cancelStreamRetry() {
  cancelTimeout(streamRetryTimer);
  streamRetryTimer = null;
  streamProbeAbort?.abort();
  streamProbeAbort = null;
  streamProbe?.destroy();
  streamProbe = null;
}

function scheduleStreamRetry() {
  if (
    streamRetryTimer ||
    streamProbe ||
    !streamFallback ||
    !canStream() ||
    pageHidden ||
    !playerVisible() ||
    !navigator.onLine ||
    playerMedia.remoteActive ||
    status?.state !== 'live' ||
    pageReplay.reviewing
  )
    return;
  // A compatibility fallback is temporary. Probe quietly, without replacing a
  // working HLS player. Repeatedly rejected/buffered endpoints back off to 15m.
  streamRetryTimer = setTimeout(
    () => {
      streamRetryTimer = null;
      retryContinuous();
    },
    Math.min(900000, 60000 * 2 ** Math.min(streamRetryAttempts, 4)),
  );
}

async function retryContinuous() {
  if (
    streamProbe ||
    !streamFallback ||
    !canStream() ||
    pageHidden ||
    !playerVisible() ||
    !navigator.onLine ||
    playerMedia.remoteActive ||
    status?.state !== 'live' ||
    pageReplay.reviewing
  )
    return;
  cancelTimeout(streamRetryTimer);
  streamRetryTimer = null;
  streamRetryAttempts++;
  const session = pageReplay.session;
  if (!session) return;
  const abort = (streamProbeAbort = new AbortController());
  const timeout = setTimeout(() => abort.abort(), 10000);
  const probe = (streamProbe = new PlayerVideoStream(session, () => abort.abort(), {
    failureLimit: 1,
    quiet: true,
    backend,
  }));
  let adopted = false;
  try {
    // Headers or heartbeats alone cannot prove video will stream through a proxy.
    await probe.waitFor(
      () => (probe.cache.size >= 2 && probe.cache.has(probe.index?.last ?? -1) ? true : null),
      abort.signal,
    );
    if (
      !abort.signal.aborted &&
      streamProbe === probe &&
      streamFallback &&
      pageReplay.session?.session_id === session.session_id &&
      navigator.onLine &&
      !pageHidden &&
      playerVisible() &&
      !playerMedia.remoteActive &&
      !pageReplay.reviewing &&
      status?.state === 'live'
    ) {
      streamProbe = null;
      streamProbeAbort = null;
      streamFallback = false;
      streamRetryAttempts = 0;
      adopted = true;
      console.info('[LayerGlass] Continuous video recovered');
      await attachPlayer(probe, true);
    }
  } catch (_) {
    /* Keep the working HLS player and retry after the cooldown. */
  } finally {
    cancelTimeout(timeout);
    if (streamProbe === probe) streamProbe = null;
    streamProbeAbort = null;
    if (adopted && videoStream !== probe && pageReplay.session?.session_id === session.session_id)
      streamFallback = true;
    if (!adopted) probe.destroy();
    scheduleStreamRetry();
  }
}

function detachPlayer() {
  directStream?.destroy();
  directStream = null;
  cancelStreamRetry();
  loadingSuspended = false;
  cancelTimeout(refreshTimer);
  cancelTimeout(jpegTimer);
  refreshTimer = null;
  jpegTimer = null;
  playerMedia.clearSource();
  videoStream?.destroy();
  videoStream = null;
  if (hls) {
    hls.destroy();
    hls = null;
  }
  videoCodec = null;
  video.pause();
  video.removeAttribute('src');
  for (const source of video.querySelectorAll('source')) source.remove();
  video.load();
  pageReplay.clearImage();
  jpeg.removeAttribute('src');
  jpeg.hidden = true;
  video.hidden = false;
  attachedGeneration = null;
  lastFrameAt = 0;
  lastDecodedFrames = null;
}

async function attachPlayer(prepared: PlayerVideoStream | null = null, recovering = false) {
  if (
    !networkAvailable() ||
    pageHidden ||
    !playerVisible() ||
    playerMedia.remoteActive ||
    status?.state !== 'live' ||
    (!status.playlist_url && !status.jpeg_url && !status.media_url && !status.mjpeg_url) ||
    pageReplay.opening
  ) {
    prepared?.destroy();
    return;
  }
  const version = selectionVersion;
  const camera = selectedCamera;
  if (!camera) return;
  const priorSession = pageReplay.session?.session_id;
  attachedGeneration = status.generation ?? null;
  try {
    await pageReplay.open(camera);
  } catch (_) {
    /* Live playback remains available if temporary storage is unavailable. */
  }
  if (
    version !== selectionVersion ||
    !networkAvailable() ||
    pageHidden ||
    !playerVisible() ||
    playerMedia.remoteActive
  ) {
    prepared?.destroy();
    return;
  }
  pageReplay.attachMedia({
    preserve: Boolean(recovering && priorSession && priorSession === pageReplay.session?.session_id),
  });
  detachPlayer();
  const session = pageReplay.session?.session_id;
  const ownsSession = () => version === selectionVersion && session === pageReplay.session?.session_id;
  attachedGeneration = pageReplay.session?.session_id || status.generation || null;
  lastAttachAt = Date.now();
  waiting('Loading the live view', 'Getting the latest image from your camera.');
  if (status.mjpeg_url && backend.capabilities.liveOnly) {
    reloadAutoplay = false;
    video.hidden = true;
    jpeg.hidden = false;
    playerTools.updateMini();
    const stream = (directStream = new DirectMjpegStream(jpeg, status.mjpeg_url, {
      onFrame: () => {
        if (directStream !== stream) return;
        directRetryAttempts = 0;
        pageReplay.mediaReady();
      },
      onFailure: (error) => {
        if (directStream !== stream || version !== selectionVersion) return;
        pageReplay.mediaReady();
        console.warn('[LayerGlass] Direct webcam interrupted', {
          type: errorName(error),
          message: errorMessage(error),
        });
        waiting('Reconnecting the camera', 'Direct live camera connection interrupted.');
        scheduleRefresh(Math.min(30000, 1000 * 2 ** Math.min(directRetryAttempts++, 5)));
      },
    }));
    return;
  }
  if (status.media_url) {
    // Browser/demo media uses the same native decoder and custom controls, with
    // no Python relay, HLS polling, or network-discovery side effects.
    try {
      const source = backend.prepareMedia ? await backend.prepareMedia() : status.media_url;
      if (version !== selectionVersion) return;
      if (pageHidden || !playerVisible()) {
        attachedGeneration = null;
        pageReplay.mediaReady();
        return;
      }
      if (!source) throw new Error('Media unavailable');
      video.src = source;
      video.disableRemotePlayback = true;
      if (!pageReplay.paused) play();
    } catch (error) {
      if (version !== selectionVersion) return;
      pageReplay.mediaReady();
      console.warn('[LayerGlass] Demo video unavailable', errorName(error));
      waiting('Loading the demo', 'Retrying the sample video.');
      scheduleRefresh();
    }
    return;
  }
  if (status.jpeg_url) {
    reloadAutoplay = false;
    video.hidden = true;
    jpeg.hidden = false;
    const url = status.jpeg_url;
    const version = selectionVersion;
    const next = () => {
      if (version !== selectionVersion) return;
      if (navigator.onLine && playerVisible() && status?.state === 'live' && !pageReplay.reviewing)
        pageReplay.showLiveImage(`${url}?t=${Date.now()}`);
      jpegTimer = setTimeout(next, 1000);
    };
    next();
    pageReplay.mediaReady();
    return;
  }
  const source = `${pageReplay.session?.playlist_url || status.playlist_url}?viewer=${Date.now()}`;
  const hlsSupported = Hls.isSupported();
  const continuous = !streamFallback && canStream();
  // Modern Safari can use ManagedMediaSource with the same hardware decoder.
  // Older Safari retains native HLS, including its platform seek support.
  if (
    !continuous &&
    video.canPlayType('application/vnd.apple.mpegurl') &&
    (typeof video.webkitEnterFullscreen === 'function' || !hlsSupported)
  ) {
    video.src = source;
    playerMedia.setSource(source);
    if (!pageReplay.paused) play();
  } else if (hlsSupported) {
    if (continuous) {
      const transport = (videoStream =
        prepared || new PlayerVideoStream(pageReplay.session!, () => {}, { backend }));
      transport.failureLimit = 3;
      transport.quiet = false;
      transport.onFailure = () => {
        if (transport !== videoStream || !ownsSession() || playerMedia.remoteActive) return;
        streamFallback = true;
        attachPlayer(null, true);
      };
      if (pageReplay.mediaRestore && !pageReplay.followLive) {
        // The initial index arrives before its live media burst. Let that burst
        // establish the loader's next sequence before asking it for old footage.
        const canLoad = () =>
          networkAvailable() && !pageHidden && playerVisible() && !playerMedia.remoteActive;
        for (;;) {
          try {
            await transport.waitFor(
              () => (canLoad() && transport.nextSequence !== null ? true : null),
              AbortSignal.timeout(45000),
            );
          } catch (_) {
            if (transport !== videoStream || !ownsSession()) return;
            if (canLoad()) {
              transport.onFailure();
              return;
            }
            // A suspended transport reconnects on visibility/network restoration.
            // Keep its initializer waiting too, even if this deadline elapsed.
            continue;
          }
          if (transport !== videoStream || !ownsSession()) return;
          if (!canLoad()) continue;
          break;
        }
      }
    }
    const decoder = (hls = new Hls({
      enableWorker: true,
      preferManagedMediaSource: true,
      liveDurationInfinity: true,
      lowLatencyMode: false,
      liveSyncDurationCount: 2,
      ...(pageReplay.mediaRestore && !pageReplay.followLive ? { startPosition: pageReplay.position } : {}),
      workerPath: new URL('./vendor/hls.worker.js', import.meta.url).href,
      // Keep playback memory bounded on phones. Full page history remains on
      // the server and can be fetched again when seeking outside this buffer.
      maxBufferLength: 12,
      maxMaxBufferLength: 24,
      maxBufferSize: 8 * 1024 * 1024,
      backBufferLength: 12,
      frontBufferFlushThreshold: 24,
      ...(videoStream ? { loader: videoStream.loader(Hls) } : {}),
    }));
    PlayerLog.changed('info', 'Video delivery', {
      transport: videoStream ? 'Continuous HTTP stream' : 'HLS',
    });
    hls.on(Hls.Events.MEDIA_ATTACHING, () => playerMedia.setSource(source));
    hls.on(
      Hls.Events.MEDIA_ATTACHED,
      (_event, data) => data.mediaSource && playerMedia.setMediaSource(decoder, data.mediaSource),
    );
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      if (hls !== decoder || !ownsSession()) return;
      pageReplay.mediaReady();
      if (!pageReplay.paused) play();
    });
    hls.on(Hls.Events.BUFFER_CODECS, (_event, tracks) => {
      videoCodec = tracks.video?.codec || tracks.audiovideo?.codec || null;
    });
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (!navigator.onLine || pageHidden || !playerVisible() || playerMedia.remoteActive) return;
      if (data.fatal) {
        console.error('[LayerGlass] Playback error', { type: data.type, detail: data.details });
        // Decoder/SourceBuffer errors do not establish a transport failure.
        // Rebuild the player with continuous delivery; only failed HTTP streams
        // can enable the temporary HLS compatibility path.
        waiting('Reconnecting the viewer', 'Playback will resume automatically.');
        scheduleRefresh();
      }
    });
    hls.loadSource(source);
    hls.attachMedia(video);
    scheduleStreamRetry();
  } else {
    waiting(
      'This browser cannot play the stream',
      'Use a current version of Chrome, Firefox, Edge or Safari.',
      false,
    );
    statusLabel.textContent = 'Unsupported';
  }
}

function finishRestart() {
  restartDeadline = 0;
  restartRequest = false;
  renderRefreshState();
}

function renderRefreshState() {
  const busy = refreshingViewer || restartRequest || Boolean(restartDeadline);
  refreshButton.disabled = busy || settingUp || !networkAvailable();
  refreshButton.setAttribute('aria-busy', String(busy));
  $('refresh-label').textContent = busy ? 'Refreshing…' : 'Refresh viewer';
}

function renderStatus() {
  renderRefreshState();
  if (!networkAvailable()) {
    statusPill.classList.remove('live');
    statusPill.classList.add('offline');
    statusLabel.textContent = 'Offline';
    $('empty-scan-button').hidden = true;
    waiting('Offline', 'Connect to your network to view your printer camera.', false);
    return;
  }
  if (!status) return;
  renderPrinterIdentity();
  const live = status.state === 'live' && lastFrameAt && Date.now() - lastFrameAt < 8000;
  statusPill.classList.toggle('live', Boolean(live && !pageReplay.reviewing));
  statusPill.classList.remove('offline');
  statusLabel.textContent = pageReplay.reviewing
    ? pageReplay.paused
      ? 'Paused'
      : 'Replay'
    : live
      ? 'Live'
      : (
          { live: 'Buffering', setup: 'Set up', empty: 'No printers', connecting: 'Connecting' } as Record<
            string,
            string
          >
        )[status.state] || 'Reconnecting';
  streamMessage.textContent = pageReplay.reviewing
    ? 'Viewing footage buffered since this page opened.'
    : live
      ? 'Receiving live video.'
      : status.message;
  if (backend.capabilities.liveOnly) {
    const button = $('live-button');
    button.classList.toggle('at-live', Boolean(live));
    button.setAttribute('aria-pressed', String(Boolean(live)));
    button.title = 'Live only — recording and rewind require the Docker backend';
    button.disabled = true;
    $('pause-button').hidden = true;
    $('replay-controls').hidden = true;
    $('replay-time').hidden = true;
    if (status.state === 'unsupported') {
      $('empty-scan-button').hidden = true;
      statusLabel.textContent = 'Direct connection unavailable';
      waiting('Direct connection unavailable', status.message, false);
      return;
    }
  }
  const unavailable = ['setup', 'empty'].includes(status.state);
  const noStreams =
    catalog?.discovery.state === 'done' && !catalog.cameras.some((camera) => camera.discovered);
  $('empty-scan-button').hidden =
    !backend.capabilities.discovery ||
    !(
      status.state !== 'live' &&
      (status.state === 'empty' || noStreams) &&
      catalog?.discovery.state !== 'scanning'
    );
  PlayerLog.changed('debug', 'Playback status', { state: status.state, viewing: statusLabel.textContent });
  if (unavailable) {
    if (attachedGeneration) detachPlayer();
    if (status.state === 'setup') {
      waiting('Connect this printer', 'Open Settings → Printers to connect its camera.', false);
    } else if (catalog?.discovery.state === 'scanning' || scanPending) {
      waiting('Looking for printer cameras', 'Scanning the local network…');
    } else {
      waiting(
        'No printer streams found',
        'Check that your printer is on and LAN live view is enabled, then tap Scan.',
        false,
      );
    }
  } else if (status.state !== 'live' && !pageReplay.hasHistory) {
    if (attachedGeneration) detachPlayer();
    const noneFound =
      catalog?.discovery.state === 'done' && !catalog.cameras.some((camera) => camera.discovered);
    waiting(
      noneFound ? 'No printer streams found' : 'Waiting for the camera',
      noneFound
        ? 'Your saved printer is offline. Check its power and camera connection, then tap Scan.'
        : 'Reconnecting automatically. Check the camera connection settings if this continues.',
      !noneFound,
    );
  } else if (
    status.state === 'live' &&
    !pageReplay.attaching &&
    attachedGeneration !== (pageReplay.session?.session_id || status.generation)
  ) {
    attachPlayer();
  }
  if (restartDeadline && (status.generation !== restartingGeneration || Date.now() > restartDeadline))
    finishRestart();
}

function selectCamera(key: string | null) {
  if (selectedCamera === key && status) return;
  selectionVersion += 1;
  streamFallback = false;
  streamRetryAttempts = 0;
  directRetryAttempts = 0;
  selectedCamera = key;
  writeCamera(key);
  status = null;
  pageReplay.close();
  detachPlayer();
  finishRestart();
  waiting(
    key ? 'Connecting to your camera' : 'Looking for printer cameras',
    'The live view will appear here.',
  );
  renderPrinterIdentity();
  updates.subscribe(key);
}

function renderPrinterIdentity() {
  const camera = catalog?.cameras.find((item) => item.id === selectedCamera);
  const printer = status && status.camera_id === selectedCamera ? status.printer : null;
  const model = camera?.model_name || printer?.model || camera?.model || 'Printer camera';
  const heading = $('camera-name');
  if (heading.textContent !== model) heading.textContent = model;
  const id = camera?.serial || camera?.id || '';
  playerMedia.setIdentity(model, id);
  const identity = $('camera-id');
  if (identity.textContent !== id) identity.textContent = id;
  if (identity.hidden !== !id) identity.hidden = !id;
}

function renderScanState() {
  const scanning = scanPending || catalog?.discovery.state === 'scanning';
  playerChrome.settings.searching = scanning;
  $('scan-button').disabled = scanning || settingUp;
  $('scan-button').setAttribute('aria-busy', String(scanning));
  $('scan-label').textContent = scanning ? 'Scanning…' : 'Scan';
  playerTools.stats.renderActivity();
  return scanning;
}

function renderCatalog() {
  if (!catalog) return;
  const discovery = catalog.discovery;
  const detected = catalog.cameras.filter((camera) => camera.discovered);
  const choices = catalog.cameras;
  if (!choices.some((camera) => camera.id === selectedCamera)) {
    selectCamera(
      choices.find((camera) => camera.id === catalog!.default_camera_id)?.id || choices[0]?.id || null,
    );
  }
  cameraList.setPrinters(choices, selectedCamera, settingUp);
  $('printers-button').hidden = !backend.capabilities.discovery && !backend.capabilities.cameraSelection;
  playerChrome.settings.discoveryEnabled = backend.capabilities.discovery;
  $('scan-button').disabled ||= !backend.capabilities.discovery;
  playerChrome.settings.busy = settingUp;
  renderRefreshState();
  const selected = choices.find((camera) => camera.id === selectedCamera);
  renderPrinterIdentity();
  $('selected-printer').textContent = selected?.name || '—';
  const scanning = renderScanState();
  const message = $('discovery-message');
  if (backend.capabilities.liveOnly) {
    message.textContent =
      'Configured cameras from the verified printer/controller. Direct mode has no network scan or recording.';
  } else if (scanning) {
    message.textContent = 'Scanning for printer cameras…';
  } else if (!discovery.networks.length) {
    message.textContent =
      'No scan network configured. Set your printer’s LAN subnet in the server configuration.';
  } else if (discovery.state === 'error') {
    message.textContent = 'The network scan failed. Tap Scan to try again.';
  } else if (!detected.length) {
    message.textContent =
      'No printer streams found. Check the printer’s power and LAN live view, then scan again.';
  } else {
    const count = detected.length;
    message.textContent = `${count} printer${count === 1 ? '' : 's'} found on ${discovery.networks.join(', ')}.`;
  }
  PlayerLog.discovery(discovery);
  renderStatus();
}

async function loadCatalog() {
  try {
    const response = await backend.fetch('/api/cameras', {
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error('Discovery unavailable');
    catalog = (await response.json()) as CameraCatalog;
    renderCatalog();
  } catch (_) {
    PlayerLog.changed('warn', 'Printer list', { state: 'Unavailable; reconnecting' });
    $('discovery-message').textContent = 'Cannot reach the viewer. Retrying automatically…';
  }
}

async function loadStatus() {
  if (polling) return;
  polling = true;
  const version = selectionVersion;
  try {
    const query = selectedCamera ? `?camera=${encodeURIComponent(selectedCamera)}` : '';
    const response = await backend.fetch(`/api/status${query}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error('Viewer unavailable');
    const incoming = (await response.json()) as StreamStatus;
    if (version !== selectionVersion) return;
    status = incoming;
    renderStatus();
  } catch (_) {
    if (version !== selectionVersion) return;
    updatesUnavailable();
  } finally {
    polling = false;
  }
}

function applyUpdates(incoming: BackendSnapshot) {
  if (incoming.catalog) {
    catalog = incoming.catalog;
    renderCatalog();
  }
  if (incoming.status && (incoming.status.camera_id || null) === selectedCamera) {
    status = incoming.status;
    renderStatus();
  }
  if (Object.hasOwn(incoming, 'replay')) pageReplay.updateMetadata(incoming.session_id, incoming.replay);
  if (incoming.telemetry) printerHistory.apply(incoming.telemetry, false);
  renderStatus();
}

function updatesUnavailable() {
  if (!navigator.onLine) {
    renderStatus();
    return;
  }
  PlayerLog.changed('warn', 'Updates', { state: 'Reconnecting' });
  statusPill.classList.remove('live');
  statusPill.classList.add('offline');
  statusLabel.textContent = 'Offline';
  streamMessage.textContent = 'Connection updates are unavailable. Reconnecting automatically…';
  if (!pageReplay.hasHistory && !lastFrameAt) {
    waiting('Reconnecting to the viewer', 'Check your connection to the NAS. We’ll keep trying.');
  }
}

async function post(path: string, payload: object = {}): Promise<unknown> {
  const response = await backend.fetch(path, {
    method: 'POST',
    headers: { 'X-Viewer-Request': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });
  const body = await response.json();
  if (!response.ok)
    throw new Error(isRecord(body) && typeof body.error === 'string' ? body.error : 'Request failed.');
  return body;
}

cameraList.addEventListener('printer-select', (event) => {
  if (settingUp) return;
  selectCamera(event.detail.cameraId);
  renderCatalog();
  playerChrome.options(false);
});
cameraList.addEventListener('printer-forget', (event) => forgetPrinter(event.detail.cameraId));
playerChrome.addEventListener('printer-scan', scanPrinters);
async function scanPrinters() {
  if (!backend.capabilities.discovery) return;
  if (scanPending || catalog?.discovery.state === 'scanning') return;
  scanPending = true;
  renderScanState();
  try {
    const result = (await post('/api/discover')) as { discovery?: DiscoveryInfo; queued?: boolean };
    if (result.discovery) PlayerLog.discovery(result.discovery, result.queued);
  } catch (_) {
    PlayerLog.discovery({ state: 'error', networks: [], cameras: [], checked: 0, total: 0 }, true);
  } finally {
    scanPending = false;
    await loadCatalog();
    renderScanState();
  }
}
cameraList.addEventListener('printer-save', async (event) => {
  const { cameraId: key, code } = event.detail;
  const row = cameraList.row(key);
  if (!row || settingUp) return;
  const document = row.ownerDocument;
  const focusOwner = row.form.contains(document.activeElement)
    ? { input: row.input, revision: cameraList.editorRevision, moved: false }
    : null;
  const focusListeners = new AbortController();
  let failed = false;
  settingUp = true;
  row.error = '';
  row.saving = true;
  renderCatalog();
  if (focusOwner) {
    // Observe deliberate navigation after the busy render has disabled the
    // editor. Its synchronous focus loss to body still belongs to this request.
    const moved = (event: Event) => {
      if (
        event.type === 'keydown'
          ? (event as KeyboardEvent).key === 'Tab'
          : !(event.target instanceof Node && row.form.contains(event.target))
      )
        focusOwner.moved = true;
    };
    for (const type of ['focusin', 'pointerdown', 'keydown'])
      document.addEventListener(type, moved, { capture: true, signal: focusListeners.signal });
  }
  try {
    await post(`/api/cameras/${key}/configure`, { access_code: code });
    cameraList.closeEditor();
    await loadCatalog();
    if (selectedCamera === key) status = null;
    selectCamera(key);
    await loadStatus();
    playerChrome.options(false);
  } catch (error) {
    failed = true;
    console.error('[LayerGlass] Printer configuration failed', errorMessage(error));
    row.error = 'Could not save this camera connection. Try again.';
  } finally {
    focusListeners.abort();
    settingUp = false;
    row.saving = false;
    renderCatalog();
    if (
      failed &&
      focusOwner &&
      !focusOwner.moved &&
      !document.hidden &&
      document.hasFocus() &&
      [document.body, document.documentElement].some((element) => element === document.activeElement) &&
      cameraList.row(key) === row &&
      cameraList.editorRevision === focusOwner.revision &&
      cameraList.editingCamera === key &&
      row.input === focusOwner.input &&
      row.isConnected &&
      !row.form.hidden &&
      !playerChrome.panel.hidden &&
      playerChrome.settings.page === 'printers' &&
      row.input.getClientRects().length
    )
      row.input.focus({ preventScroll: true });
  }
});

async function forgetPrinter(key: string) {
  if (settingUp) return;
  const row = cameraList.row(key);
  if (!row) return;
  const index = [...cameraList.children].indexOf(row);
  let forgotten = false;
  settingUp = true;
  row.error = '';
  renderCatalog();
  try {
    await post(`/api/cameras/${key}/forget`);
    forgotten = true;
    await loadCatalog();
    await loadStatus();
  } catch (error) {
    console.error('[LayerGlass] Could not forget printer', errorMessage(error));
    row.error = 'Could not forget this printer. Try again.';
  } finally {
    settingUp = false;
    renderCatalog();
    if (forgotten && !playerChrome.panel.hidden && playerChrome.settings.page === 'printers') {
      if (!cameraList.focusNearest(index)) $('scan-button').focus({ preventScroll: true });
    }
  }
}

refreshButton.addEventListener('click', async () => {
  if (refreshingViewer || restartRequest || restartDeadline || settingUp || !networkAvailable()) return;
  refreshingViewer = true;
  streamFallback = false;
  streamRetryAttempts = 0;
  directRetryAttempts = 0;
  cancelStreamRetry();
  cancelTimeout(refreshTimer);
  refreshTimer = null;
  renderRefreshState();
  const version = selectionVersion;
  try {
    const restartStream =
      backend.capabilities.serverDvr &&
      selectedCamera &&
      status &&
      !['setup', 'empty', 'unsupported'].includes(status.state);
    if (restartStream && status && selectedCamera) {
      restartRequest = true;
      restartingGeneration = status.generation ?? null;
      console.info('[LayerGlass] Refreshing viewer and camera stream');
      await post(`/api/restart?camera=${encodeURIComponent(selectedCamera)}`);
      if (version !== selectionVersion) return;
      restartRequest = false;
      selectionVersion += 1;
      status = { ...status!, state: 'reconnecting' };
      detachPlayer();
      restartDeadline = Date.now() + 20000;
      renderStatus();
      waiting('Restarting the stream', 'Reconnecting to the camera. This may take a few seconds.');
      loadStatus();
    } else {
      if (backend.capabilities.liveOnly) {
        try {
          await backend.refresh?.();
        } catch (error) {
          console.warn('[LayerGlass] Direct printer connection unavailable', errorName(error));
        }
      }
      await loadCatalog();
      await loadStatus();
      if (status?.state === 'live') attachPlayer();
      else renderStatus();
    }
    playerChrome.options(false);
  } catch (error) {
    if (version !== selectionVersion) return;
    finishRestart();
    console.error('[LayerGlass] Viewer refresh failed', errorMessage(error));
    streamMessage.textContent = 'Could not refresh. Check the backend connection and try again.';
  } finally {
    refreshingViewer = false;
    renderRefreshState();
  }
});
playerChrome.addEventListener('player-play', play);
playerChrome.addEventListener('printer-scan-open', () => {
  playerChrome.options(true, 'printers');
  scanPrinters();
});
video.addEventListener('pause', () => {
  playerChrome.show();
  renderStatus();
});
video.addEventListener('play', () => {
  playerChrome.show();
  renderStatus();
});
for (const event of ['loadeddata', 'seeked'])
  video.addEventListener(event, () => {
    if (pageReplay.mediaReady() && video.paused && !video.hidden) play();
  });
// Reload state carries intent, not a browser activation grant. Retry once media
// is ready after an interrupted initial play; permission denial keeps the tap fallback.
video.addEventListener('canplay', () => {
  if (reloadAutoplay && !video.hidden && status?.state === 'live') play();
});
$('pause-button').addEventListener('click', () => {
  reloadAutoplay = false;
});
window.addEventListener('replayexpired', () => {
  if (status?.state === 'live') attachPlayer();
});
video.addEventListener('error', () => {
  if (attachedGeneration && !video.hidden) scheduleRefresh();
});

window.addEventListener('offline', () => {
  if (backend.id === 'demo') return;
  if (directStream) {
    detachPlayer();
    pageReplay.mediaReady();
  }
  cancelStreamRetry();
  resumeAfterOffline = video.hidden ? !pageReplay.paused : !video.paused;
  hls?.stopLoad();
  video.pause();
  if (video.hidden) pageReplay.paused = true;
  renderStatus();
});
window.addEventListener('online', () => {
  printerHistory.retry();
  waiting('Reconnecting the viewer', 'Playback will resume when the camera is available.');
  hls?.startLoad(video.currentTime || -1);
  if (resumeAfterOffline) {
    if (video.hidden) pageReplay.paused = false;
    else if (video.readyState >= 2) play();
  }
  resumeAfterOffline = false;
  // A deliberately paused frame remains paused through a connection change.
  if (lastFrameAt && (video.hidden || video.readyState >= 2)) viewer.markFrame();
  renderStatus();
});

setInterval(() => {
  renderStatus();
  scheduleStreamRetry();
  if (restartDeadline && Date.now() > restartDeadline) finishRestart();
  if (
    !playerVisible() ||
    playerMedia.remoteActive ||
    status?.state !== 'live' ||
    pageReplay.reviewing ||
    video.paused
  )
    return;
  const reference = lastFrameAt || lastAttachAt;
  if (reference && Date.now() - reference > 18000 && Date.now() - lastAttachAt > 18000 && playButton.hidden)
    attachPlayer(null, true);
}, 3000);
function syncPlaybackVisibility() {
  if (pageHidden || !playerVisible()) {
    if (directStream) {
      detachPlayer();
      pageReplay.mediaReady();
    }
    cancelStreamRetry();
    cancelTimeout(refreshTimer);
    refreshTimer = null;
    // Cancel hls.js loader deadlines as well as the HTTP body reader. Otherwise
    // an intentionally suspended tab can report fatal fragment timeouts later.
    hls?.stopLoad();
    loadingSuspended = Boolean(hls);
  } else if (!playerMedia.remoteActive) {
    if (status?.state === 'live' && !pageReplay.reviewing && Date.now() - lastFrameAt > 10000)
      attachPlayer(null, true);
    else if (loadingSuspended) {
      loadingSuspended = false;
      hls?.startLoad(video.currentTime || -1);
    }
    scheduleStreamRetry();
  }
}
document.addEventListener('visibilitychange', syncPlaybackVisibility);
window.addEventListener('playerviewchange', syncPlaybackVisibility);
window.addEventListener('pagehide', () => {
  pageHidden = true;
  syncPlaybackVisibility();
});
window.addEventListener('pageshow', () => {
  pageHidden = false;
  syncPlaybackVisibility();
});
updates.subscribe(selectedCamera);
renderStatus(); // Cached app shells can start without any network metadata.

// Readable live module bindings for integration checks and local diagnostics.
export {
  hls,
  pageReplay,
  playerChrome,
  playerFullscreen,
  playerMedia,
  playerPullRefresh,
  playerTools,
  printerHistory,
  previewHistory,
  previewCapture,
  reloadAutoplay,
  scanPending,
  selectedCamera,
  status,
  streamFallback,
  streamProbe,
  streamRetryAttempts,
  streamRetryTimer,
  loadingSuspended,
  retryContinuous,
  updates,
  video,
  videoStream,
  directStream,
};
