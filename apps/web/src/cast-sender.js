const SDK = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1';
let loading;

export function castError(error) {
  return typeof error === 'string' ? error : typeof error?.code === 'string' ? error.code : error?.name || 'Error';
}

export function castPlatform(video, view = window) {
  return Boolean(view.isSecureContext && view.chrome && view.navigator.presentation &&
    typeof view.PresentationRequest === 'function' && typeof video.webkitShowPlaybackTargetPicker !== 'function');
}

export function loadCastSDK(view = window) {
  if (view.cast?.framework && view.chrome?.cast?.isAvailable) return Promise.resolve();
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new DOMException('Cast SDK did not initialize.', 'TimeoutError')), 12000);
    const finish = error => {
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    // This callback is required by Google's vendor API; application code stays ESM.
    view.__onGCastApiAvailable = available => finish(available && view.cast?.framework ? null :
      new DOMException('Google Cast is unavailable.', 'NotSupportedError'));
    const script = view.document.createElement('script');
    script.src = SDK;
    script.async = true;
    script.onerror = () => finish(new DOMException('Cast SDK could not load.', 'NetworkError'));
    view.document.head.append(script);
  });
  return loading;
}

// Google Cast loads a reachable HLS URL on the receiver. Chrome's generic
// RemotePlayback API cannot initiate remoting from our local MediaSource blob.
export class GoogleCastSender {
  constructor(video, replay, identity, changed, { backend = null } = {}) {
    Object.assign(this, { video, replay, identity, changed });
    this.eligible = castPlatform(video);
    this.state = 'idle';
    this.version = 0;
    this.backend = backend;
    this.latest = { start: 0, end: 0, current: 0, paused: false };
  }

  setSource(source) {
    const url = new URL(source, location.href);
    const valid = (!this.backend || this.backend.capabilities.casting) &&
      url.origin === (this.backend?.origin || location.origin) && !url.username && !url.password &&
      /^\/(?:replay\/[a-f0-9]{32}|stream\/(?:[a-f0-9]{16}\/)?[a-f0-9]{32})\/live\.m3u8$/.test(url.pathname);
    const next = valid ? url.href : null;
    if (this.source && this.source !== next) this.clearSource();
    this.source = next;
    if (this.source && this.eligible && !this.initializing) this.initialize();
  }

  initialize() {
    this.state = 'loading';
    this.initializing = loadCastSDK().then(() => {
      const framework = window.cast.framework;
      this.context = framework.CastContext.getInstance();
      this.remote = new framework.RemotePlayer();
      this.controller = new framework.RemotePlayerController(this.remote);
      this.controller.addEventListener(framework.RemotePlayerEventType.ANY_CHANGE, () => this.sync());
      this.context.addEventListener(framework.CastContextEventType.SESSION_STATE_CHANGED, () => this.sync());
      this.context.setOptions({ receiverApplicationId: window.chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
        autoJoinPolicy: window.chrome.cast.AutoJoinPolicy.TAB_AND_ORIGIN_SCOPED, resumeSavedSession: false });
      this.state = 'ready';
      this.changed();
    }).catch(error => {
      this.state = 'unavailable';
      console.warn('[LayerGlass] Google Cast unavailable', error.name);
      this.changed();
    });
    this.changed();
  }

  get ready() { return this.state === 'ready' && Boolean(this.source); }
  get needsHTTPS() {
    return !window.isSecureContext && Boolean(window.chrome) && this.video.currentSrc?.startsWith('blob:') &&
      typeof this.video.webkitShowPlaybackTargetPicker !== 'function';
  }
  get connected() { return Boolean(this.active || this.pending && this.context?.getCurrentSession()); }
  get paused() { return this.latest.paused; }
  bounds() { return { start: this.latest.start, end: this.latest.end, current: this.latest.current }; }

  async request() {
    if (!this.ready || this.pending) return;
    const version = this.version;
    const source = this.source;
    const alreadyActive = this.active;
    this.pending = true;
    try {
      // No SDK download or await before this call: retain the original click's activation.
      await this.context.requestSession();
      if (version !== this.version || source !== this.source) {
        if (!alreadyActive) this.context.getCurrentSession()?.endSession(true);
        return;
      }
      const session = this.context.getCurrentSession();
      if (!session || alreadyActive && this.active) return;
      const cast = window.chrome.cast;
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
      if (this.replay.reviewing) request.currentTime = Math.max(0, this.replay.bounds().current - this.offset);
      this.changed();
      await session.loadMedia(request);
      if (version !== this.version || source !== this.source) return;
      this.loadedSource = source;
      this.sync();
    } catch (error) {
      // Cancellation and load failure never replace the local video/decoder.
      const code = castError(error);
      if (!this.active && this.context?.getCurrentSession() && !['cancel', 'NotAllowedError'].includes(code)) {
        this.context.getCurrentSession().endSession(true);
      }
      throw error;
    } finally {
      this.pending = false;
      this.changed();
    }
  }

  sync() {
    const media = this.context?.getCurrentSession()?.getMediaSession();
    const active = Boolean(this.loadedSource && this.remote?.isConnected && this.remote.isMediaLoaded !== false &&
      (media?.media?.contentId || this.remote.mediaInfo?.contentId) === this.loadedSource);
    if (active) {
      const range = this.remote.liveSeekableRange;
      const current = media?.getEstimatedTime?.() ?? this.remote.currentTime;
      const previous = this.latest;
      this.latest = {
        start: Number.isFinite(range?.start) ? this.offset + range.start : this.replay.session?.start_seconds || 0,
        end: Number.isFinite(range?.end) ? this.offset + range.end : this.replay.session?.end_seconds || 0,
        current: Number.isFinite(current) ? this.offset + current : previous.current,
        paused: Boolean(this.remote.isPaused),
      };
      if (this.replay.remote === this && (this.paused || this.latest.current < previous.current - 2)) this.replay.followLive = false;
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
    if (this.active && this.remote.isPaused) this.controller.playOrPause();
  }

  togglePause() {
    if (this.active) this.controller.playOrPause();
  }

  seek(position) {
    if (!this.active) return;
    const { start, end } = this.bounds();
    this.latest.current = Math.max(start, Math.min(end - 0.1, position));
    this.remote.currentTime = Math.max(0, this.latest.current - this.offset);
    this.controller.seek();
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
