import { cancelTimeout } from '../../backend-contracts/src/index.js';
import { errorName, isRecord } from '../../backend-contracts/src/index.js';
import type { Backend } from '../../backend-contracts/src/index.js';
import type { CastContext, CastRemotePlayer, CastRemoteController } from './cast-types.js';
import type { PageReplay } from './replay.js';
import type { PlayerIdentity } from './player-state.js';
import { isFiniteNumber } from '../../backend-contracts/src/index.js';
const SDK = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1';
let loading: Promise<void> | null;

export function castError(error: unknown) {
  return typeof error === 'string'
    ? error
    : isRecord(error) && typeof error.code === 'string'
      ? error.code
      : errorName(error);
}

export function castPlatform(video: HTMLVideoElement, view = window) {
  return Boolean(
    view.isSecureContext &&
    view.chrome &&
    view.navigator.presentation &&
    typeof view.PresentationRequest === 'function' &&
    typeof video.webkitShowPlaybackTargetPicker !== 'function',
  );
}

export function loadCastSDK(view = window) {
  if (view.cast?.framework && view.chrome?.cast?.isAvailable) return Promise.resolve();
  if (loading) return loading;
  loading = new Promise<void>((resolve, reject) => {
    let settled = false;
    const previous = view.__onGCastApiAvailable;
    const script = view.document.createElement('script');
    const available = (value: boolean) =>
      finish(
        value && view.cast?.framework
          ? null
          : new DOMException('Google Cast is unavailable.', 'NotSupportedError'),
      );
    const finish = (error: unknown) => {
      if (settled) return;
      settled = true;
      cancelTimeout(timer);
      if (error && view.__onGCastApiAvailable === available) {
        if (previous === undefined) delete view.__onGCastApiAvailable;
        else view.__onGCastApiAvailable = previous;
      }
      script.onerror = null;
      if (error) {
        script.remove();
        reject(error);
      } else resolve();
    };
    const timer = setTimeout(
      () => finish(new DOMException('Cast SDK did not initialize.', 'TimeoutError')),
      12000,
    );
    // This callback is required by Google's vendor API; application code stays ESM.
    view.__onGCastApiAvailable = available;
    script.src = SDK;
    script.async = true;
    script.onerror = () => finish(new DOMException('Cast SDK could not load.', 'NetworkError'));
    try {
      view.document.head.append(script);
    } catch (error) {
      finish(error);
    }
  }).catch((error) => {
    loading = null;
    throw error;
  });
  return loading;
}

// Google Cast loads a reachable HLS URL on the receiver. Chrome's generic
// RemotePlayback API cannot initiate remoting from our local MediaSource blob.
export class GoogleCastSender {
  declare readonly video: HTMLVideoElement;
  declare readonly replay: PageReplay;
  declare readonly identity: () => PlayerIdentity;
  declare readonly changed: () => void;
  declare readonly eligible: boolean;
  declare readonly backend: Backend | null;
  declare state: string;
  declare version: number;
  declare latest: { start: number; end: number; current: number; paused: boolean };
  source: string | null = null;
  loadedSource: string | null = null;
  active = false;
  pending = false;
  offset = 0;
  context: CastContext | null = null;
  remote: CastRemotePlayer | null = null;
  controller: CastRemoteController | null = null;
  initializing: Promise<void> | null = null;
  constructor(
    video: HTMLVideoElement,
    replay: PageReplay,
    identity: () => PlayerIdentity,
    changed: () => void,
    { backend = null }: { backend?: Backend | null } = {},
  ) {
    Object.assign(this, { video, replay, identity, changed });
    this.eligible = castPlatform(video);
    this.state = 'idle';
    this.version = 0;
    this.backend = backend;
    this.latest = { start: 0, end: 0, current: 0, paused: false };
  }

  setSource(source: string) {
    const url = new URL(source, location.href);
    const valid =
      (!this.backend || this.backend.capabilities.casting) &&
      url.origin === (this.backend?.origin || location.origin) &&
      !url.username &&
      !url.password &&
      /^\/(?:replay\/[a-f0-9]{32}|stream\/(?:[a-f0-9]{16}\/)?[a-f0-9]{32})\/live\.m3u8$/.test(url.pathname);
    const next = valid ? url.href : null;
    if (this.source && this.source !== next) this.clearSource();
    this.source = next;
    if (this.source && this.eligible && !this.initializing) this.initialize();
  }

  initialize() {
    if (this.initializing) return this.initializing;
    this.state = 'loading';
    this.initializing = loadCastSDK()
      .then(() => {
        const framework = window.cast?.framework;
        const cast = window.chrome?.cast;
        if (!framework || !cast) throw new Error('Google Cast is unavailable');
        this.context = framework.CastContext.getInstance();
        this.remote = new framework.RemotePlayer();
        this.controller = new framework.RemotePlayerController(this.remote);
        const controller = this.controller,
          context = this.context;
        const playerEvent = framework.RemotePlayerEventType.ANY_CHANGE;
        const sessionEvent = framework.CastContextEventType.SESSION_STATE_CHANGED;
        const sync = () => this.sync();
        try {
          controller.addEventListener(playerEvent, sync);
          context.addEventListener(sessionEvent, sync);
          context.setOptions({
            receiverApplicationId: cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
            autoJoinPolicy: cast.AutoJoinPolicy.TAB_AND_ORIGIN_SCOPED,
            resumeSavedSession: false,
          });
          this.state = 'ready';
          this.changed();
        } catch (error) {
          controller.removeEventListener(playerEvent, sync);
          context.removeEventListener(sessionEvent, sync);
          this.context = null;
          this.remote = null;
          this.controller = null;
          throw error;
        }
      })
      .catch((error) => {
        this.initializing = null;
        this.state = 'unavailable';
        console.warn('[LayerGlass] Google Cast unavailable', errorName(error));
        this.changed();
      });
    this.changed();
    return this.initializing;
  }

  get ready() {
    return this.state === 'ready' && Boolean(this.source);
  }
  get needsHTTPS() {
    return (
      !window.isSecureContext &&
      Boolean(window.chrome) &&
      this.video.currentSrc?.startsWith('blob:') &&
      typeof this.video.webkitShowPlaybackTargetPicker !== 'function'
    );
  }
  get connected() {
    return Boolean(this.active || (this.pending && this.context?.getCurrentSession()));
  }
  get paused() {
    return this.latest.paused;
  }
  bounds() {
    return { start: this.latest.start, end: this.latest.end, current: this.latest.current };
  }

  async request() {
    const context = this.context;
    const source = this.source;
    if (!this.ready || this.pending || !context || !source) return;
    const version = this.version;
    const alreadyActive = this.active;
    this.pending = true;
    try {
      // No SDK download or await before this call: retain the original click's activation.
      await context.requestSession();
      if (version !== this.version || source !== this.source) {
        if (!alreadyActive) context.getCurrentSession()?.endSession(true);
        return;
      }
      const session = context.getCurrentSession();
      if (!session || (alreadyActive && this.active)) return;
      const cast = window.chrome?.cast;
      if (!cast) throw new Error('Google Cast is unavailable');
      const info = new cast.media.MediaInfo(source, 'application/vnd.apple.mpegurl');
      info.streamType = cast.media.StreamType.LIVE;
      info.metadata = new cast.media.GenericMediaMetadata();
      const identity = this.identity();
      info.metadata.title = identity.model;
      info.metadata.subtitle = identity.id;
      info.metadata.images = [new cast.Image(new URL('/static/icons/icon-512.png', location.href).href)];
      const request = new cast.media.LoadRequest(info);
      request.autoplay = !this.replay.paused;
      this.offset = this.replay.session?.start_seconds || 0;
      if (this.replay.reviewing)
        request.currentTime = Math.max(0, this.replay.bounds().current - this.offset);
      this.changed();
      await session.loadMedia(request);
      if (version !== this.version || source !== this.source) return;
      this.loadedSource = source;
      this.sync();
    } catch (error) {
      // Cancellation and load failure never replace the local video/decoder.
      const code = castError(error);
      if (
        !this.active &&
        this.context?.getCurrentSession() &&
        !['cancel', 'NotAllowedError'].includes(code)
      ) {
        context.getCurrentSession()!.endSession(true);
      }
      throw error;
    } finally {
      this.pending = false;
      this.changed();
    }
  }

  sync() {
    const media = this.context?.getCurrentSession()?.getMediaSession();
    const active = Boolean(
      this.loadedSource &&
      this.remote?.isConnected &&
      this.remote.isMediaLoaded !== false &&
      (media?.media?.contentId || this.remote.mediaInfo?.contentId) === this.loadedSource,
    );
    if (active && this.remote) {
      const range = this.remote.liveSeekableRange;
      const current = media?.getEstimatedTime?.() ?? this.remote.currentTime;
      const previous = this.latest;
      this.latest = {
        start: isFiniteNumber(range?.start)
          ? this.offset + range!.start
          : this.replay.session?.start_seconds || 0,
        end: isFiniteNumber(range?.end) ? this.offset + range!.end : this.replay.session?.end_seconds || 0,
        current: isFiniteNumber(current) ? this.offset + current : previous.current,
        paused: Boolean(this.remote.isPaused),
      };
      if (this.replay.remote === this && (this.paused || this.latest.current < previous.current - 2))
        this.replay.followLive = false;
    }
    this.active = active;
    if (active && this.replay.remote !== this) this.replay.setRemote(this);
    else if (!active && this.replay.remote === this) this.replay.setRemote(null);
    if (active) {
      this.replay.paused = this.paused;
      this.replay.position = this.latest.current;
      this.replay.render();
    }
    this.changed();
  }

  play() {
    if (this.active && this.remote?.isPaused) this.controller?.playOrPause();
  }

  togglePause() {
    if (this.active) this.controller?.playOrPause();
  }

  seek(position: number) {
    if (!this.active || !this.remote) return;
    const { start, end } = this.bounds();
    this.latest.current = Math.max(start, Math.min(end - 0.1, position));
    this.remote.currentTime = Math.max(0, this.latest.current - this.offset);
    this.controller?.seek();
  }

  goLive() {
    if (!this.active) return;
    this.seek(this.latest.end - 2);
    this.play();
  }

  clearSource() {
    this.version++;
    const session = this.context?.getCurrentSession();
    const owned = this.active || this.pending;
    this.source = null;
    this.loadedSource = null;
    this.active = false;
    if (this.replay.remote === this) this.replay.setRemote(null, false);
    if (owned && session) session.endSession(true);
  }
}
