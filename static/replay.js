import { PlayerLog } from './log.js';
import { playerVisible } from './visibility.js';

const scrubKeys = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End']);

export class ReplayTimeline {
  constructor() { this.reset(); }

  reset() {
    this.edge = null;
    this.observedEnd = null;
    this.lastTime = null;
    this.window = null;
    this.mode = null;
    this.fitRequested = false;
  }

  fit() { this.fitRequested = true; }

  frame({ start, end, current, live, paused, scrubbing, now, advancing }) {
    if (this.edge === null) {
      this.edge = end;
      this.observedEnd = end;
    } else {
      // HLS reports complete segments, not a continuously moving edge. Project
      // between reports like a live tracker, but never indefinitely through a
      // lost connection. This is display time; seeks use real available bounds.
      const elapsed = Math.max(0, now - this.lastTime);
      if (advancing) this.edge += elapsed;
      this.observedEnd = Math.max(this.observedEnd, end);
      this.edge = Math.max(this.observedEnd, Math.min(this.edge, this.observedEnd + 6));
    }
    this.lastTime = now;

    const mode = scrubbing ? 'scrub' : live ? 'live' : paused ? 'paused' : 'playing';
    if (!this.window || this.fitRequested || mode === 'live' || (mode === 'playing' && this.mode !== 'playing')) {
      // Explicit interactions fit all retained page history. While replaying,
      // keep this span and slide both ends with Live instead of growing the
      // denominator or holding a stationary end ahead of the playhead.
      this.window = { start, end: this.edge };
    } else if (mode === 'playing') {
      const shift = this.edge - this.window.end;
      this.window.start += shift;
      this.window.end = this.edge;
    }
    this.window.start = Math.max(start, this.window.start);
    this.window.end = Math.max(this.window.start, this.window.end);
    this.mode = mode;
    this.fitRequested = false;
    return { ...this.window,
      value: live && !scrubbing ? this.window.end : Math.max(this.window.start, Math.min(this.window.end, current)),
      behindLive: Math.max(0, this.edge - current) };
  }
}

// Each instance belongs to one page. Only its opaque session ID reaches the browser.
export class PageReplay {
  constructor(video, image, livePosition, onSession = () => {}, backend = {}) {
    this.video = video;
    this.image = image;
    this.livePosition = livePosition;
    this.onSession = onSession;
    this.backend = backend;
    this.fetcher = backend.fetch?.bind(backend) || ((...args) => fetch(...args));
    this.controls = document.getElementById('replay-controls');
    this.slider = document.getElementById('replay-slider');
    this.pauseButton = document.getElementById('pause-button');
    this.liveButton = document.getElementById('live-button');
    this.clock = document.getElementById('replay-time');
    this.detail = document.getElementById('replay-detail');
    this.caption = document.getElementById('caption-label');
    this.session = null;
    this.opening = null;
    this.version = 0;
    this.followLive = true;
    this.paused = false;
    this.attaching = false;
    this.position = 0;
    this.lastTick = performance.now();
    this.lastImagePosition = null;
    this.ignoreSeekingUntil = 0;
    this.timeline = new ReplayTimeline();
    this.scrubbing = false;
    this.previewPosition = null;
    this.scrubKeys = new Set();
    this.slider.addEventListener('pointerdown', event => {
      if (event.isPrimary === false || event.button > 0) return;
      if (this.beginScrub('pointer')) this.scrubPointer = event.pointerId;
    }, { capture: true });
    this.slider.addEventListener('keydown', event => {
      if (event.key === 'Escape') { this.finishScrub(false); return; }
      if (scrubKeys.has(event.key) && this.beginScrub('keyboard')) this.scrubKeys.add(event.key);
    });
    this.slider.addEventListener('blur', () => {
      if (this.scrubType === 'keyboard') this.finishScrub(false);
    });
    this.slider.addEventListener('wheel', event => this.scroll(event), { passive: false });
    const pointerUp = event => {
      if (this.ignoreScrubInput && event.pointerId === this.cancelledPointer) this.ignoreScrubInput = false;
      if (this.scrubType === 'pointer' && event.pointerId === this.scrubPointer) this.finishScrub();
    };
    const cancelScrub = () => this.finishScrub(false);
    const keyUp = event => {
      if (this.scrubType !== 'keyboard' || !scrubKeys.has(event.key)) return;
      this.scrubKeys.delete(event.key);
      if (!this.scrubKeys.size) this.finishScrub();
    };
    // End on pointerup/keyup: native change may fire on every key repeat or
    // when a touch is cancelled, and must not commit an intermediate position.
    const scrubEvents = { pointerup: pointerUp,
      pointercancel: () => { cancelScrub(); this.ignoreScrubInput = false; },
      focus: () => { if (!this.scrubbing) this.ignoreScrubInput = false; },
      blur: cancelScrub, resize: cancelScrub, keyup: keyUp,
      keydown: event => { if (event.key === 'Escape') cancelScrub(); }, offline: cancelScrub };
    let scrubWindow;
    const bindScrub = () => {
      cancelScrub();
      for (const [name, listener] of Object.entries(scrubEvents)) scrubWindow?.removeEventListener(name, listener);
      scrubWindow = video.ownerDocument?.defaultView || window;
      for (const [name, listener] of Object.entries(scrubEvents)) scrubWindow.addEventListener(name, listener);
    };
    bindScrub();
    window.addEventListener('playerviewchange', bindScrub);
    document.addEventListener('visibilitychange', () => { if (!playerVisible()) cancelScrub(); });
    this.slider.addEventListener('input', () => {
      if (this.ignoreScrubInput) return;
      const target = Number(this.slider.value);
      if (this.scrubbing) this.previewSeek(target);
      else this.seek(target); // Assistive input without a pointer/key gesture.
    });
    this.pauseButton.addEventListener('click', () => this.togglePause());
    this.liveButton.addEventListener('click', () => this.goLive());
    video.addEventListener('pause', () => {
      if (this.remote) return;
      if (!this.attaching) { this.followLive = false; this.paused = true; this.position = video.currentTime; }
      this.render();
    });
    video.addEventListener('play', () => { if (!this.remote) { this.paused = false; this.render(); } });
    video.addEventListener('seeking', () => {
      if (this.remote) return;
      if (!this.attaching && Date.now() > this.ignoreSeekingUntil && this.bounds().end - video.currentTime > 5) this.followLive = false;
    });
    setInterval(() => this.tick(), 250);
    window.addEventListener('pagehide', event => { if (!event.persisted) this.close(); });
  }

  get reviewing() { return Boolean(this.session && (!this.followLive || this.paused)); }
  get hasHistory() { return Boolean(this.session?.ready); }

  async open(camera) {
    if (this.session?.camera_id === camera) return this.session;
    if (this.opening) return this.opening;
    const version = this.version;
    this.opening = (async () => {
      const response = await this.fetcher('/api/sessions', { method: 'POST',
        headers: { 'X-Viewer-Request': '1', 'Content-Type': 'application/json' },
        body: JSON.stringify({ camera_id: camera }), signal: AbortSignal.timeout(6000) });
      if (!response.ok) throw new Error('Rewind unavailable');
      const session = await response.json();
      if (!session.session_id) throw new Error('Rewind unavailable');
      if (version !== this.version) { this.release(session.session_id); return null; }
      this.session = session;
      this.controls.hidden = false;
      this.onSession(session);
      this.render();
      return session;
    })();
    try { return await this.opening; }
    finally { if (version === this.version) this.opening = null; }
  }

  release(token) {
    this.fetcher(`/api/sessions/${token}/close`, { method: 'POST', keepalive: true,
      headers: { 'X-Viewer-Request': '1' }, body: '{}' }).catch(() => {});
  }

  close() {
    this.remote = null;
    this.finishScrub(false);
    this.version += 1;
    const hadSession = Boolean(this.session);
    if (this.session) this.release(this.session.session_id);
    this.session = null;
    this.opening = null;
    this.controls.hidden = true;
    this.pauseButton.disabled = true;
    this.liveButton.disabled = true;
    this.liveButton.classList.remove('at-live');
    this.liveButton.setAttribute('aria-pressed', 'false');
    this.clock.hidden = true;
    this.detail.hidden = true;
    this.followLive = true;
    this.paused = false;
    this.position = 0;
    this.timeline.reset();
    this.scrubbing = false;
    if (hadSession) this.onSession(null);
  }

  updateMetadata(token, metadata) {
    if (!token || this.session?.session_id !== token) return;
    if (metadata === null) {
      this.close();
      window.dispatchEvent(new Event('replayexpired'));
      return;
    }
    if (metadata?.session_id !== token || metadata.camera_id !== this.session.camera_id) return;
    this.session = metadata;
    this.render();
  }

  attachMedia() {
    this.finishScrub(false);
    this.attaching = true;
    this.followLive = true;
    this.paused = false;
    this.timeline.fit();
    this.scrubbing = false;
    this.ignoreSeekingUntil = Date.now() + 3000;
  }

  mediaReady() { this.attaching = false; this.render(); }

  bounds() {
    const session = this.session;
    if (!session) return { start: 0, end: 0, current: 0 };
    if (this.remote) return this.remote.bounds();
    if (session.kind === 'jpeg') {
      return { start: session.start_seconds, end: session.end_seconds,
        current: this.followLive ? session.end_seconds : this.position };
    }
    if (session.kind === 'file') {
      const end = Math.max(0, Math.min(Number.isFinite(this.video.duration) ? this.video.duration : Infinity, session.end_seconds));
      return { start: 0, end, current: Math.min(end, this.video.currentTime || 0) };
    }
    const ranges = this.video.seekable;
    const start = Math.max(session.start_seconds, ranges.length ? ranges.start(0) : session.start_seconds);
    const end = ranges.length ? ranges.end(ranges.length - 1) : session.end_seconds;
    return { start, end, current: this.video.currentTime || 0 };
  }

  beginScrub(kind) {
    if (!this.session?.ready || this.slider.disabled || this.backend.id !== 'demo' && globalThis.navigator?.onLine === false) return false;
    if (this.scrubbing && this.scrubType === kind) return true;
    this.finishScrub(false);
    this.scrubbing = true;
    this.scrubType = kind;
    this.ignoreScrubInput = false;
    this.previewChanged = false;
    this.previewPosition = Number(this.slider.value);
    this.timeline.fit();
    this.render(true);
    return true;
  }

  previewSeek(target) {
    if (!this.scrubbing || !Number.isFinite(target)) return;
    const { start, end } = this.bounds();
    if (end <= start) return;
    this.previewPosition = Math.max(start, Math.min(end - 0.05, target));
    this.previewChanged = true;
    this.slider.value = this.previewPosition;
    this.render();
    this.slider.dispatchEvent(new CustomEvent('replaypreviewchange', { detail: { active: true, kind: this.scrubType } }));
  }

  finishScrub(commit = true) {
    if (!this.scrubbing) return;
    const target = this.previewPosition;
    const kind = this.scrubType;
    const changed = this.previewChanged;
    if (!commit && kind === 'pointer') {
      this.ignoreScrubInput = true;
      this.cancelledPointer = this.scrubPointer;
    }
    clearTimeout(this.scrollTimer);
    this.scrollTimer = null;
    this.scrubbing = false;
    this.scrubType = null;
    this.scrubPointer = null;
    this.previewPosition = null;
    this.scrubKeys.clear();
    this.timeline.fit();
    if (commit && changed && Number.isFinite(target) && this.session?.ready && !this.slider.disabled &&
        (this.backend.id === 'demo' || globalThis.navigator?.onLine !== false)) this.seek(target);
    else this.render();
    this.slider.dispatchEvent(new CustomEvent('replaypreviewchange', { detail: { active: false, kind, cancelled: !commit } }));
  }

  scroll(event) {
    if (event.ctrlKey || event.metaKey || this.scrubbing && this.scrubType !== 'wheel') return;
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    if (!Number.isFinite(delta) || !delta || !this.beginScrub('wheel')) return;
    event.preventDefault();
    const width = Math.max(1, this.slider.clientWidth - 16);
    const pixels = delta * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? width : 1);
    const span = Number(this.slider.max) - Number(this.slider.min);
    this.previewSeek(this.previewPosition + Math.max(-width, Math.min(width, pixels)) * span / width);
    clearTimeout(this.scrollTimer);
    // One committed seek after wheel/trackpad events stop; no video requests
    // are made for the intermediate thumbnail positions.
    this.scrollTimer = setTimeout(() => this.finishScrub(), 250);
  }

  seek(target) {
    this.finishScrub(false);
    const { start, end } = this.bounds();
    if (end <= start) return;
    this.followLive = false;
    this.position = Math.max(start, Math.min(end - 0.05, target));
    if (!this.scrubbing) this.timeline.fit();
    if (this.remote) this.remote.seek(this.position);
    else if (this.session.kind === 'jpeg') this.showImage(this.position);
    else this.video.currentTime = this.position;
    this.render();
    window.dispatchEvent(new Event('replaypositionchange'));
  }

  showImage(position) {
    const rounded = Math.floor(position * 2) / 2;
    if (this.lastImagePosition === rounded) return;
    this.lastImagePosition = rounded;
    this.image.src = `${this.session.frame_url}?at=${rounded}`;
  }

  togglePause() {
    if (!this.session) return;
    if (this.remote) { this.remote.togglePause(); return; }
    if (this.session.kind === 'jpeg') {
      if (!this.paused) { this.position = this.bounds().current; this.followLive = false; }
      this.paused = !this.paused;
    } else if (this.video.paused) {
      this.video.play().catch(() => {});
    } else {
      this.followLive = false;
      this.video.pause();
    }
    this.render();
    window.dispatchEvent(new Event('replaypositionchange'));
  }

  goLive() {
    this.finishScrub(false);
    if (!this.session) return;
    this.followLive = true;
    this.paused = false;
    this.ignoreSeekingUntil = Date.now() + 1000;
    this.lastImagePosition = null;
    if (this.remote) this.remote.goLive();
    else if (this.session.kind === 'jpeg') {
      this.position = this.session.end_seconds;
      const path = `/api/cameras/${this.session.camera_id}/frame.jpg?t=${Date.now()}`;
      this.image.src = this.backend.resolve ? this.backend.resolve(path) : path;
    } else {
      const { start, end } = this.bounds();
      if (end > start) {
        const target = this.livePosition();
        this.video.currentTime = Math.max(start, Math.min(end - 0.1, Number.isFinite(target) ? target : end - 1));
      }
      // Avoid queuing a redundant play while a seek is in flight.
      if (this.video.paused) this.video.play().catch(() => {});
    }
    this.render();
    window.dispatchEvent(new Event('replaypositionchange'));
  }

  setRemote(remote, resume = true) {
    const previous = this.remote;
    if (previous === remote) return;
    this.remote = remote;
    if (remote) {
      this.paused = remote.paused;
      this.position = remote.bounds().current;
      this.video.pause();
    } else if (previous && resume && this.session) {
      this.position = previous.bounds().current;
      this.paused = previous.paused;
      if (this.followLive && !this.paused) this.goLive();
      else {
        this.video.currentTime = this.position;
        if (!this.paused) this.video.play().catch(() => {});
      }
    }
    this.render();
  }

  static time(seconds) {
    const total = Math.max(0, Math.floor(seconds));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor(total / 60) % 60;
    const secs = String(total % 60).padStart(2, '0');
    return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${secs}` : `${minutes}:${secs}`;
  }

  render(updateDuringScrub = false) {
    if (!this.session) return;
    const { start, end, current } = this.bounds();
    const playhead = this.paused ? this.position : current;
    const previewing = this.scrubbing && Number.isFinite(this.previewPosition);
    const timeline = this.timeline.frame({ start, end: Math.max(end, this.session.end_seconds), current: previewing ? this.previewPosition : playhead,
      live: this.followLive, paused: this.paused, scrubbing: this.scrubbing, now: performance.now() / 1000,
      advancing: this.session.ready && !this.session.error });
    if (!this.scrubbing || updateDuringScrub) {
      this.slider.min = timeline.start;
      this.slider.max = timeline.end;
      this.slider.value = timeline.value;
    }
    const span = Number(this.slider.max) - Number(this.slider.min);
    const progress = span > 0 ? Math.max(0, Math.min(1, (Number(this.slider.value) - Number(this.slider.min)) / span)) : 0;
    const fill = `${(progress * 100).toFixed(4)}%`;
    if (this.slider.style.getPropertyValue('--scrub-progress') !== fill) this.slider.style.setProperty('--scrub-progress', fill);
    const offline = this.backend.id !== 'demo' && globalThis.navigator?.onLine === false;
    this.slider.disabled = offline || !this.session.ready || end - start < 1;
    const behindLive = Math.max(0, this.timeline.edge - playhead);
    const offset = `−${PageReplay.time(behindLive)}`;
    const showOffset = !this.followLive && behindLive >= 1;
    this.slider.setAttribute('aria-valuetext', previewing ? `−${PageReplay.time(this.timeline.edge - this.previewPosition)} from live` : showOffset ? `${offset} from live` : 'Live');
    const clock = this.clock;
    clock.hidden = !showOffset;
    clock.textContent = offset;
    const detail = this.session.error || (this.session.limited ? 'Oldest footage trimmed to keep the buffer within its storage limit.' :
      this.reviewing ? `${PageReplay.time(behindLive)} behind live` : 'Buffered since this page opened');
    this.detail.textContent = detail;
    this.detail.hidden = !(this.session.error || this.session.limited);
    PlayerLog.changed(this.session.error ? 'warn' : 'debug', 'Replay buffer',
      { ready: this.session.ready, error: this.session.error, limited: this.session.limited });
    clock.title = `${PageReplay.time(behindLive)} behind live`;
    this.pauseButton.classList.toggle('paused', this.paused);
    this.pauseButton.setAttribute('aria-label', this.paused ? 'Play buffered video' : 'Pause video');
    this.pauseButton.disabled = offline || !this.session.ready;
    this.liveButton.disabled = offline || !this.session.ready;
    this.liveButton.classList.toggle('at-live', !offline && !this.reviewing);
    this.liveButton.setAttribute('aria-pressed', String(!offline && !this.reviewing));
    this.caption.textContent = this.reviewing ? (this.paused ? 'PAUSED' : 'REPLAY') : 'LIVE VIEW';
  }

  tick() {
    const now = performance.now();
    const elapsed = Math.min(1, (now - this.lastTick) / 1000);
    this.lastTick = now;
    if (!this.session) return;
    if (this.session.kind === 'jpeg' && !this.followLive && !this.paused && playerVisible()) {
      this.position = Math.max(this.session.start_seconds, Math.min(this.session.end_seconds, this.position + elapsed));
      this.showImage(this.position);
    }
    this.render();
  }
}
