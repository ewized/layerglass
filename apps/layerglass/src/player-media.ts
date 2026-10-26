import type Hls from 'hls.js';
import type { Backend } from '../../backend-contracts/src/index.js';
import type { PageReplay } from './replay.js';
import type { PlayerIdentity } from './player-state.js';
import { required } from './dom.js';
import { isFiniteNumber } from '../../backend-contracts/src/index.js';
import { setRemotePlayback } from './visibility.js';
import { GoogleCastSender, castError } from './cast-sender.js';

// Native pickers and Media Session control the existing video, decoder and DVR.
// Google Cast uses the network HLS URL; Safari retains its native AirPlay picker.
export class PlayerMedia {
  declare player: HTMLElementTagNameMap['printer-player'];
  declare video: HTMLVideoElement;
  declare replay: PageReplay;
  declare play: () => void;
  declare mini: () => void;
  declare remoteChanged: (active: boolean) => void;
  declare button: HTMLButtonElement;
  declare session: MediaSession | undefined;
  declare identity: PlayerIdentity;
  declare source: string | null;
  declare remoteActive: boolean;
  declare handlers: Set<MediaSessionAction>;
  declare sender: GoogleCastSender;

  mediaSource: MediaSource | null = null;
  pipeline: Hls | null = null;
  mediaSourceEvents: AbortController | null = null;
  durationPending: AbortController | null = null;
  prompting = false;
  metadataKey: string | null = null;
  actionsAvailable: boolean | undefined;
  constructor(
    player: HTMLElementTagNameMap['printer-player'],
    video: HTMLVideoElement,
    replay: PageReplay,
    {
      play,
      mini,
      remoteChanged = () => {},
      backend = null,
    }: {
      play: () => void;
      mini: () => void;
      remoteChanged?: (active: boolean) => void;
      backend?: Backend | null;
    },
  ) {
    Object.assign(this, { player, video, replay, play, mini, remoteChanged });
    this.button = required<HTMLButtonElement>(player, '#cast-button');
    this.session = navigator.mediaSession;
    // Native video supplies the live position clock. Manual position overrides
    // caused a large frame-delivery regression in WebKit; keep it browser-owned.
    this.identity = { model: 'Printer camera', id: '' };
    this.source = null;
    this.remoteActive = false;
    this.handlers = new Set();
    this.sender = new GoogleCastSender(
      video,
      replay,
      () => this.identity,
      () => {
        this.syncRemote();
        this.update();
      },
      { backend },
    );
    player.addEventListener('cast-request', () => this.cast());
    for (const name of [
      'loadedmetadata',
      'loadeddata',
      'emptied',
      'play',
      'pause',
      'ended',
      'seeking',
      'seeked',
    ]) {
      video.addEventListener(name, () => this.update());
    }
    window.addEventListener('replaypositionchange', () => this.update());
    for (const name of ['connecting', 'connect', 'disconnect'])
      video.remote?.addEventListener(name, () => this.syncRemote());
    video.addEventListener('webkitcurrentplaybacktargetiswirelesschanged', () => this.syncRemote());
    this.update();
  }

  get available() {
    return Boolean(
      this.source &&
      !this.video.hidden &&
      (this.sender.connected || (this.video.readyState > 0 && !this.video.error)),
    );
  }
  get webkitPicker() {
    return typeof this.video.webkitShowPlaybackTargetPicker === 'function';
  }
  get supported() {
    return this.sender.needsHTTPS
      ? false
      : this.sender.eligible
        ? this.sender.ready
        : this.webkitPicker || typeof this.video.remote?.prompt === 'function';
  }

  setIdentity(model: string, id: string) {
    if (this.identity.model === model && this.identity.id === id) return;
    this.identity = { model, id };
    this.update();
  }

  setSource(url: string) {
    this.source = url;
    this.sender.setSource(url);
    // hls.js creates a <source> for ManagedMediaSource and initially disables
    // remoting. Supply the network HLS alternative before enabling AirPlay.
    // The first (blob) source stays selected; appending this does not load it.
    if (this.webkitPicker) {
      const primary = this.video.querySelector('source');
      if (!this.video.hasAttribute('src') && primary?.src.startsWith('blob:')) {
        let alternate = this.video.querySelector<HTMLSourceElement>('[data-cast-source]');
        if (!alternate) {
          alternate = this.video.ownerDocument.createElement('source');
          alternate.setAttribute('data-cast-source', '');
          alternate.type = 'application/x-mpegURL';
          alternate.src = new URL(url, location.href).href;
          this.video.appendChild(alternate);
        } else alternate.src = new URL(url, location.href).href;
      }
      this.video.setAttribute('x-webkit-airplay', 'allow');
    }
    this.video.disableRemotePlayback = false;
    this.update();
  }

  clearSource() {
    this.sender.clearSource();
    this.clearMediaSource();
    this.source = null;
    this.video.querySelector<HTMLSourceElement>('[data-cast-source]')?.remove();
    this.remoteActive = false;
    setRemotePlayback(false);
    this.button.setAttribute('aria-pressed', 'false');
    this.update();
  }

  setMediaSource(pipeline: Hls, source: MediaSource) {
    this.clearMediaSource();
    this.pipeline = pipeline;
    this.mediaSource = source;
    this.mediaSourceEvents = new AbortController();
    for (const name of ['sourceopen', 'sourceclose']) {
      source.addEventListener(name, () => this.updateLive(), { signal: this.mediaSourceEvents.signal });
    }
    this.updateLive();
  }

  clearMediaSource() {
    this.mediaSourceEvents?.abort();
    this.durationPending?.abort();
    this.durationPending = null;
    this.pipeline = null;
    this.mediaSource = null;
  }

  updateLive() {
    const source = this.mediaSource;
    if (!source || !this.pipeline) return;
    const live =
      !this.replay.reviewing &&
      !(this.replay.remote ? this.replay.paused : this.video.paused) &&
      !this.video.ended;
    this.pipeline.config.liveDurationInfinity = live;
    this.durationPending?.abort();
    this.durationPending = null;
    if (source.readyState !== 'open') return;
    const buffers = Array.from(source.sourceBuffers);
    const updating = buffers.filter((buffer) => buffer.updating);
    if (updating.length) {
      const pending = (this.durationPending = new AbortController());
      for (const buffer of updating) {
        buffer.addEventListener('updateend', () => this.updateLive(), { once: true, signal: pending.signal });
      }
      return;
    }
    const bounds = this.replay.bounds();
    let end = Math.max(
      isFiniteNumber(bounds.end) ? bounds.end : 0,
      this.replay.session?.end_seconds || 0,
      this.video.currentTime || 0,
    );
    // A finite duration must cover every retained buffer, otherwise changing
    // the browser's LIVE label could trim frames or move the playback position.
    for (const buffer of buffers) {
      if (buffer.buffered.length) end = Math.max(end, buffer.buffered.end(buffer.buffered.length - 1));
    }
    const duration = live ? Infinity : end;
    if (duration > 0 && source.duration !== duration) source.duration = duration;
    if (live && end > 0) source.setLiveSeekableRange?.(Math.max(0, bounds.start), end);
  }

  async cast() {
    if (!this.available || !this.supported || this.prompting) return;
    this.prompting = true;
    this.update();
    try {
      // Invoke directly from the click, before any await consumes activation.
      if (this.sender.ready) await this.sender.request();
      else if (this.webkitPicker) this.video.webkitShowPlaybackTargetPicker?.();
      else await this.video.remote.prompt();
    } catch (error) {
      const code = castError(error);
      const cancelled = ['cancel', 'AbortError', 'NotAllowedError', 'NotFoundError'].includes(code);
      console[cancelled ? 'debug' : 'warn']('[LayerGlass] Cast picker', code);
    } finally {
      this.prompting = false;
      this.syncRemote();
      this.update();
    }
  }

  syncRemote() {
    const active = Boolean(
      this.source &&
      (this.sender.connected ||
        this.video.webkitCurrentPlaybackTargetIsWireless ||
        ['connecting', 'connected'].includes(this.video.remote?.state || '')),
    );
    if (active !== this.remoteActive) {
      this.remoteActive = active;
      setRemotePlayback(active); // Keep metadata and the page's recording lease alive.
      this.remoteChanged(active);
    }
    this.button.setAttribute('aria-pressed', String(active));
    this.button.title = active ? 'Manage casting' : this.webkitPicker ? 'Cast / AirPlay' : 'Cast';
  }

  update() {
    this.updateLive();
    const available = this.available;
    this.button.disabled = !available || !this.supported || Boolean(this.prompting);
    this.button.title = this.sender.needsHTTPS
      ? 'Use HTTPS for Cast'
      : this.sender.state === 'loading'
        ? 'Preparing Cast'
        : !this.supported
          ? 'Casting is unavailable in this browser'
          : this.remoteActive
            ? 'Manage casting'
            : this.webkitPicker
              ? 'Cast / AirPlay'
              : 'Cast';
    if (!this.session) return;
    if (available && typeof MediaMetadata === 'function') {
      const key = JSON.stringify(this.identity);
      if (key !== this.metadataKey) {
        this.session.metadata = new MediaMetadata({
          title: this.identity.model,
          artist: this.identity.id,
          album: 'LayerGlass',
          artwork: [
            {
              src: new URL('/static/icons/icon-512.png', location.href).href,
              sizes: '512x512',
              type: 'image/png',
            },
          ],
        });
        this.metadataKey = key;
      }
    } else if (!available && this.metadataKey) {
      this.session.metadata = null;
      this.metadataKey = null;
    }
    const state = !available
      ? 'none'
      : (this.replay.remote ? this.replay.paused : this.video.paused || this.video.ended)
        ? 'paused'
        : 'playing';
    if (this.session.playbackState !== state) this.session.playbackState = state;
    this.actions(available);
  }

  actions(available: boolean) {
    if (this.actionsAvailable === available) return;
    this.actionsAvailable = available;
    const pause = () => {
      if (!this.available || (this.replay.remote ? this.replay.paused : this.video.paused)) return;
      if (this.replay.session) this.replay.togglePause();
      else this.video.pause(); // Live playback also works when DVR storage is unavailable.
    };
    const seek = (details: MediaSessionActionDetails, direction: number) => {
      if (!this.available || !this.replay.hasHistory) return;
      const offset = isFiniteNumber(details.seekOffset) && details.seekOffset! > 0 ? details.seekOffset! : 10;
      this.replay.seek(this.replay.bounds().current + direction * offset);
    };
    const actions: Partial<Record<MediaSessionAction | 'enterpictureinpicture', MediaSessionActionHandler>> =
      {
        play: () => {
          if (this.available && (this.replay.remote ? this.replay.paused : this.video.paused)) {
            if (this.replay.remote) this.replay.remote.play();
            else this.play();
          }
        },
        pause,
        stop: pause,
        seekbackward: (details) => seek(details, -1),
        seekforward: (details) => seek(details, 1),
        seekto: (details) => {
          if (!this.available || !this.replay.hasHistory) return;
          if (details.seekTime === Infinity) this.replay.goLive();
          else if (isFiniteNumber(details.seekTime)) this.replay.seek(details.seekTime);
        },
        enterpictureinpicture: () => {
          if (this.available) this.mini();
        },
      };
    for (const [action, handler] of Object.entries(actions)) {
      if (!available && !this.handlers.has(action as MediaSessionAction)) continue;
      try {
        this.session!.setActionHandler(action as MediaSessionAction, available ? handler : null);
        if (available) this.handlers.add(action as MediaSessionAction);
        else this.handlers.delete(action as MediaSessionAction);
      } catch (_) {
        /* Individual Media Session actions vary by browser. */
      }
    }
  }
}
