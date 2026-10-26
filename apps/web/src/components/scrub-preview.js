import { PlayerElement } from './base.js';
import { PageReplay } from '../replay.js';
import { previewPoint, previewLeft, previewSheet } from '../scrub-preview.js';
import { PreviewHistory, PREVIEW_WIDTH, PREVIEW_HEIGHT } from '../preview-history.js';

export class PrinterScrubPreview extends PlayerElement {
  static template = `<div class="scrub-preview-frame"><canvas width="320" height="180"></canvas></div><span class="scrub-preview-time"></span>`;

  connectedCallback() {
    super.connectedCallback();
    this.hidden = true;
    this.setAttribute('aria-hidden', 'true');
    this.canvas = this.querySelector('canvas');
    this.context = this.canvas.getContext('2d', { alpha: false });
    this.clock = this.querySelector('.scrub-preview-time');
    this.bitmaps ??= new Map();
    this.bitmapBytes ??= 0;
    this.epoch ??= 0;
    this.failures ??= new Map();
    this.slider = this.parentElement.querySelector('input[type="range"]');
    if (!this.slider) return;
    this.listen(this.slider, 'pointermove', event => {
      if (this.dragging === undefined && event.pointerType === 'touch') return;
      this.atPointer(event);
    });
    this.listen(this.slider, 'pointerdown', event => {
      this.dragging = event.pointerId;
      this.atPointer(event);
    });
    this.listen(this.slider, 'pointerleave', () => { if (this.dragging === undefined) this.hide(); });
    this.listen(this.slider, 'input', () => {
      if (this.dragging === undefined && this.slider === this.ownerDocument.activeElement) {
        this.showPoint({ value: Number(this.slider.value) });
      }
    });
    this.listen(this.slider, 'blur', () => { if (this.dragging === undefined) this.hide(); });
    this.listen(this.slider, 'replaypreviewchange', event => {
      if (event.detail.active) this.showPoint({ value: this.readReplay?.().previewPosition });
      else if (event.detail.kind === 'wheel' || event.detail.cancelled) this.hide();
    });
    const view = this.ownerDocument.defaultView;
    this.listen(view, 'pointermove', event => {
      if (this.dragging === event.pointerId && event.target !== this.slider) this.atPointer(event);
    });
    this.listen(view, 'pointerup', event => {
      if (this.dragging !== event.pointerId) return;
      this.dragging = undefined;
      if (event.pointerType === 'touch' || event.target !== this.slider) this.hide();
    });
    for (const type of ['pointercancel', 'blur', 'pagehide', 'resize', 'offline']) this.listen(view, type, () => this.hide());
    this.listen(this.ownerDocument, 'visibilitychange', () => { if (this.ownerDocument.hidden) this.hide(); });
  }

  configure(readReplay, history = new PreviewHistory({ disk: null }), capture = null) {
    if (this.changed) this.history?.listeners.delete(this.changed);
    this.reset();
    Object.assign(this, { readReplay, history, capture });
    history.setSession(readReplay()?.session);
    this.changed = () => {
      if (this.resolving) this.changedDuringRead = true;
      else if (!this.hidden) this.renderLatest();
    };
    history.listeners.add(this.changed);
  }

  atPointer(event) { this.showPoint({ x: event.clientX }); }

  showPoint(position) {
    const replay = this.readReplay?.(), session = replay?.session;
    if (this.slider.disabled || !session?.ready || replay.backend?.id !== 'demo' && !this.ownerDocument.defaultView.navigator.onLine) return this.hide();
    if (session.session_id !== this.token) {
      const dragging = this.dragging;
      this.reset();
      this.dragging = dragging;
      this.token = session.session_id;
      this.history.setSession(session);
    }
    const bounds = replay.bounds(), rect = this.slider.getBoundingClientRect();
    const point = previewPoint({ min: Number(this.slider.min), max: Number(this.slider.max),
      start: Math.max(bounds.start, session.start_seconds), end: Math.min(bounds.end, session.end_seconds),
      left: rect.left, width: rect.width, ...position });
    const sheet = point && previewSheet({ time: point.time, start: session.start_seconds, end: session.end_seconds });
    if (!sheet) return this.hide();
    this.point = point;
    this.sheet = sheet;
    this.history.trim(session.start_seconds);
    this.hidden = false;
    this.style.left = `${previewLeft(point.fraction, rect.width, this.offsetWidth)}px`;
    this.clockTimer ??= setInterval(() => this.updateClock(), 500);
    this.renderLatest();
  }

  renderLatest() {
    if (this.hidden || !this.point) return;
    const found = this.history.nearest(this.point.time);
    const bitmap = found && this.bitmaps.get(found.asset.key);
    if (bitmap) {
      this.paint(found, bitmap);
      return;
    }
    // Keep a real, labelled still on screen during a disk read/decode or server
    // fallback. The time belongs to that still, never to an image not yet loaded.
    if (!this.painted && this.capture?.posterToken === this.token) {
      this.context.drawImage(this.capture.canvas, 0, 0, PREVIEW_WIDTH, PREVIEW_HEIGHT);
      this.displayed = { time: this.capture.posterTime };
      this.painted = true;
    }
    this.updateClock();
    if (!this.resolving) this.resolveLatest();
  }

  currentRead(job) {
    return !this.hidden && job.epoch === this.epoch && job.version === this.history.version &&
      job.token === this.token && job.token === this.history.token &&
      job.token === this.readReplay?.()?.session?.session_id && job.time === this.point?.time;
  }

  async resolveLatest(loaded = null) {
    const job = { time: this.point.time, epoch: this.epoch, version: this.history.version, token: this.token };
    this.resolving = job;
    try {
      // IDB can be unavailable or stalled in private/background tabs. Playback
      // must not depend on it; the same missing image may use the server instead.
      let found = loaded;
      if (!found) {
        const read = this.history.get(job.time);
        let deadline, timedOut = false;
        found = await Promise.race([read, new Promise(resolve => {
          deadline = setTimeout(() => { timedOut = true; resolve(null); }, 500);
        })]).finally(() => clearTimeout(deadline));
        if (timedOut) read.then(late => {
          if (!late || !this.currentRead(job)) return;
          // Reuse the returned Blob even if the RAM budget evicted it. A newer
          // resolution owns the decode lane until it finishes, so never fork it.
          if (this.resolving) this.changedDuringRead = true;
          else this.resolveLatest(late);
        });
      }
      if (!this.currentRead(job)) return;
      if (!found) { this.schedule(); return; }
      const bitmap = await this.bitmap(found.asset, job.epoch);
      if (!this.currentRead(job)) return;
      if (!bitmap) {
        // Corrupt/evicted local data can use the same backup as a missing image.
        for (const key of [...found.asset.refs]) this.history.forgetFrame(key);
        this.schedule();
        return;
      }
      const latest = this.history.nearest(this.point.time);
      if (latest?.frame.bucket === found.frame.bucket && latest.asset.key === found.asset.key) this.paint(found, bitmap);
    } finally {
      if (this.resolving === job) {
        this.resolving = null;
        const changed = this.changedDuringRead;
        this.changedDuringRead = false;
        if (!this.hidden && (changed || this.point.time !== job.time || this.history.version !== job.version)) this.renderLatest();
      }
    }
  }

  async bitmap(asset, epoch) {
    const existing = this.bitmaps.get(asset.key);
    if (existing) return existing;
    if (this.failures.has('decode:' + asset.key)) return null;
    try {
      let bitmap;
      if (typeof createImageBitmap === 'function') bitmap = await createImageBitmap(asset.blob);
      else {
        const image = new Image(), url = URL.createObjectURL(asset.blob);
        try { image.src = url; await image.decode(); bitmap = image; }
        finally { URL.revokeObjectURL(url); }
      }
      if (epoch !== this.epoch) { bitmap.close?.(); return null; }
      this.bitmaps.set(asset.key, bitmap);
      this.bitmapBytes += bitmap.width * bitmap.height * 4;
      // Decoded images are considerably larger than their JPEGs. Keep at most
      // 8 MiB decoded, independently of the compressed full-session history.
      while (this.bitmapBytes > 8 * 1024 * 1024 && this.bitmaps.size > 1) {
        const [key, old] = this.bitmaps.entries().next().value;
        this.bitmaps.delete(key); this.bitmapBytes -= old.width * old.height * 4; old.close?.();
      }
      return bitmap;
    } catch (_) { this.failures.set('decode:' + asset.key, Date.now() + 10000); return null; }
  }

  paint({ frame, asset }, bitmap) {
    const width = bitmap.width / asset.columns, height = bitmap.height / asset.rows;
    this.context.drawImage(bitmap, (frame.cell % asset.columns) * width, Math.floor(frame.cell / asset.columns) * height,
      width, height, 0, 0, PREVIEW_WIDTH, PREVIEW_HEIGHT);
    this.bitmaps.delete(asset.key); this.bitmaps.set(asset.key, bitmap);
    clearTimeout(this.requestTimer); this.requestTimer = null;
    this.displayed = { ...frame, asset: asset.key };
    this.painted = true;
    this.updateClock();
  }

  updateClock() {
    const replay = this.readReplay?.();
    if (replay?.session?.session_id !== this.token || this.slider.disabled ||
        !this.point || this.point.time < replay.session.start_seconds) return this.hide();
    const time = this.painted ? this.displayed.time : this.point.time;
    const approximate = this.painted && Math.abs(time - this.point.time) > 5 ? '≈ ' : '';
    this.clock.textContent = `${approximate}−${PageReplay.time(Math.max(0, (replay.timeline.edge ?? replay.session.end_seconds) - time))}`;
  }

  schedule() {
    if (this.readReplay?.().session?.preview_fallback === false) return;
    if (this.hidden || this.request || this.requestTimer) return;
    this.requestTimer = setTimeout(() => {
      this.requestTimer = null;
      if (this.hidden || this.history.peek(this.point.time)) return;
      const key = `${this.sheet.start}:${this.sheet.count}`;
      for (const [entry, until] of this.failures) if (until <= Date.now()) this.failures.delete(entry);
      if (!this.failures.has(key) && !this.failures.has('decode:sheet:' + key)) {
        this.load(key, this.token, { ...this.sheet });
      }
    }, 100);
  }

  async load(key, token, sheet) {
    const request = { controller: new AbortController(), key, sheet };
    this.request = request;
    try {
      const replay = this.readReplay();
      const fetcher = replay.backend?.fetch?.bind(replay.backend) || ((...args) => fetch(...args));
      const response = await fetcher(`/replay/${token}/preview.jpg?at=${sheet.start}&frames=${sheet.count}`,
        { signal: request.controller.signal, cache: 'no-store', priority: 'low' });
      if (!response.ok || !response.headers.get('Content-Type')?.startsWith('image/jpeg')) throw new Error('Preview unavailable');
      const blob = await response.blob();
      if (request.controller.signal.aborted || token !== this.token || this.hidden ||
          sheet.start < this.readReplay().session.start_seconds) return;
      this.history.addSheet(sheet, blob);
    } catch (_) {
      if (!request.controller.signal.aborted) this.failures.set(key, Date.now() + 10000);
    } finally {
      if (this.request === request) {
        this.request = null;
        if (!this.hidden) this.renderLatest();
      }
    }
  }

  hide() {
    const visible = !this.hidden;
    this.hidden = true;
    this.epoch++;
    this.resolving = null;
    this.dragging = undefined;
    clearTimeout(this.requestTimer); this.requestTimer = null;
    this.request?.controller.abort(); this.request = null;
    clearInterval(this.clockTimer); this.clockTimer = null;
    if (visible) this.emit('scrub-preview-end');
  }

  reset() {
    this.hide();
    for (const bitmap of this.bitmaps?.values() || []) bitmap.close?.();
    this.bitmaps?.clear(); this.bitmapBytes = 0;
    this.failures?.clear();
    this.context?.clearRect(0, 0, PREVIEW_WIDTH, PREVIEW_HEIGHT);
    this.painted = false;
    this.displayed = this.point = this.sheet = this.token = null;
  }

  disconnectedCallback() {
    this.reset();
    if (this.changed) this.history?.listeners.delete(this.changed);
    super.disconnectedCallback();
  }
}
