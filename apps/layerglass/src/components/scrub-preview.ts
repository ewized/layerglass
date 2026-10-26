import { nativeFetch } from '../../../backend-contracts/src/index.js';
import { cancelTimeout, cancelInterval } from '../../../backend-contracts/src/index.js';
import type { PreviewCapture } from '../preview-history.js';
import type { PreviewAsset, PreviewMatch, PreviewSheet, PreviewBitmap } from '../preview-types.js';
interface PreviewRead {
  time: number;
  epoch: number;
  version: number;
  token: string | null;
}
import { PlayerElement } from './base.js';
import { PageReplay } from '../replay.js';
import { previewPoint, previewLeft, previewSheet } from '../scrub-preview.js';
import { PreviewHistory, PREVIEW_INTERVAL, PREVIEW_WIDTH, PREVIEW_HEIGHT } from '../preview-history.js';

export class PrinterScrubPreview extends PlayerElement {
  declare canvas: HTMLCanvasElement;
  declare context: CanvasRenderingContext2D | null;
  declare clock: HTMLElement;
  declare bitmaps: Map<string, PreviewBitmap>;
  declare bitmapBytes: number;
  declare epoch: number;
  declare failures: Map<string, number>;
  declare slider: HTMLInputElement;
  declare dragging: number | undefined;
  declare readReplay: (() => PageReplay) | undefined;
  declare history: PreviewHistory;
  declare capture: PreviewCapture | null;
  declare changed: (() => void) | undefined;
  declare changedDuringRead: boolean;
  declare token: string | null;
  declare point: { fraction: number; time: number } | null;
  declare sheet: PreviewSheet | null;
  declare resolving: PreviewRead | null;
  declare request: { controller: AbortController; key: string; sheet: PreviewSheet } | null;
  declare requestTimer: ReturnType<typeof setTimeout> | null;
  declare clockTimer: ReturnType<typeof setInterval> | null;
  declare displayed: { time: number; asset?: string } | null;
  declare painted: boolean;

  static override template = `<div class="scrub-preview-frame"><canvas width="320" height="180"></canvas></div><span class="scrub-preview-time"></span>`;

  override connectedCallback() {
    super.connectedCallback();
    this.hidden = true;
    this.setAttribute('aria-hidden', 'true');
    this.canvas = this.required<HTMLCanvasElement>('canvas');
    this.context = this.canvas.getContext('2d', { alpha: false });
    this.clock = this.required('.scrub-preview-time');
    this.bitmaps ??= new Map();
    this.bitmapBytes ??= 0;
    this.epoch ??= 0;
    this.failures ??= new Map();
    const slider = this.parentElement!.querySelector<HTMLInputElement>('input[type="range"]');
    if (!slider) return;
    this.slider = slider;
    if (!this.slider) return;
    this.listen(this.slider, 'pointermove', (event) => {
      if (this.dragging === undefined && event.pointerType === 'touch') return;
      this.atPointer(event);
    });
    this.listen(this.slider, 'pointerdown', (event) => {
      this.dragging = event.pointerId;
      this.atPointer(event);
    });
    this.listen(this.slider, 'pointerleave', () => {
      if (this.dragging === undefined) this.hide();
    });
    this.listen(this.slider, 'input', () => {
      if (this.dragging === undefined && this.slider === this.ownerDocument.activeElement) {
        this.showPoint({ value: Number(this.slider.value) });
      }
    });
    this.listen(this.slider, 'blur', () => {
      if (this.dragging === undefined) this.hide();
    });
    this.listen(this.slider, 'replaypreviewchange', (event) => {
      if (event.detail.active) this.showPoint({ value: this.readReplay?.().previewPosition });
      else if (event.detail.kind === 'wheel' || event.detail.cancelled) this.hide();
    });
    const view = this.ownerDocument.defaultView;
    this.listen(view!, 'pointermove', (event) => {
      if (this.dragging === event.pointerId && event.target !== this.slider) this.atPointer(event);
    });
    this.listen(view!, 'pointerup', (event) => {
      if (this.dragging !== event.pointerId) return;
      this.dragging = undefined;
      if (event.pointerType === 'touch' || event.target !== this.slider) this.hide();
    });
    for (const type of ['pointercancel', 'blur', 'pagehide', 'resize', 'offline'])
      this.listen(view!, type, () => this.hide());
    this.listen(this.ownerDocument, 'visibilitychange', () => {
      if (this.ownerDocument.hidden) this.hide();
    });
  }

  configure(
    readReplay: () => PageReplay,
    history = new PreviewHistory({ disk: null }),
    capture: PreviewCapture | null = null,
  ) {
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

  atPointer(event: PointerEvent) {
    this.showPoint({ x: event.clientX });
  }

  retainedBounds(replay: PageReplay) {
    // Only a local, valid JPEG descriptor proves precise page/retention bounds.
    // Other transports keep their existing legacy session clipping.
    if (!replay.remote && replay.session?.kind === 'jpeg' && replay.jpegDescriptor?.()) {
      return { ...replay.bounds(), precise: true };
    }
    return { start: replay.session!.start_seconds, end: replay.session!.end_seconds, precise: false };
  }

  showPoint(position: { x?: number; value?: number | null }) {
    const replay = this.readReplay?.(),
      session = replay?.session;
    if (
      !replay ||
      this.slider.disabled ||
      !session?.ready ||
      (replay.backend?.id !== 'demo' && !this.ownerDocument.defaultView!.navigator.onLine)
    )
      return this.hide();
    if (session.session_id !== this.token) {
      const dragging = this.dragging;
      this.reset();
      this.dragging = dragging;
      this.token = session.session_id;
      this.history.setSession(session);
    }
    const bounds = replay.bounds(),
      retained = this.retainedBounds(replay),
      rect = this.slider.getBoundingClientRect();
    const point = previewPoint({
      min: Number(this.slider.min),
      max: Number(this.slider.max),
      start: Math.max(bounds.start, retained.start),
      end: Math.min(bounds.end, retained.end),
      left: rect.left,
      width: rect.width,
      ...position,
      value: position.value ?? undefined,
    });
    const sheet = point && previewSheet({ time: point.time, start: retained.start, end: retained.end });
    if (!point || !sheet) return this.hide();
    this.point = point;
    this.sheet = sheet;
    this.history.trim(retained.start);
    this.hidden = false;
    this.style.left = `${previewLeft(point.fraction, rect.width, this.offsetWidth)}px`;
    this.clockTimer ??= setInterval(() => this.updateClock(), 500);
    this.renderLatest();
  }

  renderLatest() {
    if (this.hidden || !this.point || !this.context) return;
    const found = this.history.nearest(this.point!.time);
    const bitmap = found && this.bitmaps.get(found.asset.key);
    if (found && bitmap) {
      this.paint(found, bitmap);
      return;
    }
    // Keep a real, labelled still on screen during a disk read/decode or server
    // fallback. The time belongs to that still, never to an image not yet loaded.
    if (!this.painted && this.capture?.posterToken === this.token && this.capture?.canvas) {
      this.context.drawImage(this.capture.canvas, 0, 0, PREVIEW_WIDTH, PREVIEW_HEIGHT);
      this.displayed = { time: this.capture.posterTime };
      this.painted = true;
    }
    this.updateClock();
    if (!this.resolving) this.resolveLatest();
  }

  currentRead(job: PreviewRead) {
    return (
      !this.hidden &&
      job.epoch === this.epoch &&
      job.version === this.history.version &&
      job.token === this.token &&
      job.token === this.history.token &&
      job.token === this.readReplay?.()?.session?.session_id &&
      job.time === this.point?.time
    );
  }

  async resolveLatest(loaded: PreviewMatch | null = null) {
    if (!this.point) return;
    const job = {
      time: this.point.time,
      epoch: this.epoch,
      version: this.history.version,
      token: this.token,
    };
    this.resolving = job;
    try {
      // IDB can be unavailable or stalled in private/background tabs. Playback
      // must not depend on it; the same missing image may use the server instead.
      let found = loaded;
      if (!found) {
        const read = this.history.get(job.time);
        let deadline: ReturnType<typeof setTimeout> | undefined;
        let timedOut = false;
        found = await Promise.race([
          read,
          new Promise<PreviewMatch | null>((resolve) => {
            deadline = setTimeout(() => {
              timedOut = true;
              resolve(null);
            }, 500);
          }),
        ]).finally(() => cancelTimeout(deadline));
        if (timedOut)
          read.then((late) => {
            if (!late || !this.currentRead(job)) return;
            // Reuse the returned Blob even if the RAM budget evicted it. A newer
            // resolution owns the decode lane until it finishes, so never fork it.
            if (this.resolving) this.changedDuringRead = true;
            else this.resolveLatest(late);
          });
      }
      if (!this.currentRead(job)) return;
      if (!found) {
        this.schedule();
        return;
      }
      const bitmap = await this.bitmap(found.asset, job.epoch);
      if (!this.currentRead(job)) return;
      if (!bitmap) {
        // Corrupt/evicted local data can use the same backup as a missing image.
        for (const key of [...found.asset.refs]) this.history.forgetFrame(key);
        this.schedule();
        return;
      }
      const latest = this.history.nearest(this.point!.time);
      if (latest?.frame.bucket === found.frame.bucket && latest.asset.key === found.asset.key)
        this.paint(found, bitmap);
    } finally {
      if (this.resolving === job) {
        this.resolving = null;
        const changed = this.changedDuringRead;
        this.changedDuringRead = false;
        if (
          !this.hidden &&
          (changed || this.point?.time !== job.time || this.history.version !== job.version)
        )
          this.renderLatest();
      }
    }
  }

  async bitmap(asset: PreviewAsset, epoch: number) {
    const existing = this.bitmaps.get(asset.key);
    if (existing) return existing;
    if (!asset.blob || this.failures.has('decode:' + asset.key)) return null;
    try {
      let bitmap: PreviewBitmap;
      if (typeof createImageBitmap === 'function') bitmap = await createImageBitmap(asset.blob);
      else {
        const image = new Image(),
          url = URL.createObjectURL(asset.blob);
        try {
          image.src = url;
          await image.decode();
          bitmap = image;
        } finally {
          URL.revokeObjectURL(url);
        }
      }
      if (epoch !== this.epoch) {
        bitmap.close?.();
        return null;
      }
      this.bitmaps.set(asset.key, bitmap);
      this.bitmapBytes += bitmap.width * bitmap.height * 4;
      // Decoded images are considerably larger than their JPEGs. Keep at most
      // 8 MiB decoded, independently of the compressed full-session history.
      while (this.bitmapBytes > 8 * 1024 * 1024 && this.bitmaps.size > 1) {
        const [key, old] = this.bitmaps.entries().next().value!;
        this.bitmaps.delete(key);
        this.bitmapBytes -= old.width * old.height * 4;
        old.close?.();
      }
      return bitmap;
    } catch (_) {
      this.failures.set('decode:' + asset.key, Date.now() + 10000);
      return null;
    }
  }

  paint({ frame, asset }: PreviewMatch, bitmap: PreviewBitmap) {
    if (!this.context) return;
    const width = bitmap.width / asset.columns,
      height = bitmap.height / asset.rows;
    this.context.drawImage(
      bitmap,
      (frame.cell % asset.columns) * width,
      Math.floor(frame.cell / asset.columns) * height,
      width,
      height,
      0,
      0,
      PREVIEW_WIDTH,
      PREVIEW_HEIGHT,
    );
    this.bitmaps.delete(asset.key);
    this.bitmaps.set(asset.key, bitmap);
    cancelTimeout(this.requestTimer);
    this.requestTimer = null;
    this.displayed = { ...frame, asset: asset.key };
    this.painted = true;
    this.updateClock();
  }

  updateClock() {
    const replay = this.readReplay?.();
    if (!replay?.session || replay.session.session_id !== this.token || this.slider.disabled || !this.point)
      return this.hide();
    const retained = this.retainedBounds(replay);
    if (this.point.time < retained.start || (retained.precise && this.point.time >= retained.end))
      return this.hide();
    const time = this.painted && this.displayed ? this.displayed.time : this.point.time;
    const approximate = this.painted && Math.abs(time - this.point.time) > 5 ? '≈ ' : '';
    this.clock.textContent = `${approximate}−${PageReplay.time(Math.max(0, (replay.timeline.edge ?? replay.session!.end_seconds) - time))}`;
  }

  schedule() {
    if (this.readReplay?.().session?.preview_fallback === false) return;
    if (this.hidden || this.request || this.requestTimer) return;
    this.requestTimer = setTimeout(() => {
      this.requestTimer = null;
      if (this.hidden || !this.point || !this.sheet || this.history.peek(this.point.time)) return;
      const key = `${this.sheet.start}:${this.sheet.count}`;
      for (const [entry, until] of this.failures) if (until <= Date.now()) this.failures.delete(entry);
      if (!this.failures.has(key) && !this.failures.has('decode:sheet:' + key)) {
        this.load(key, this.token!, { ...this.sheet });
      }
    }, 100);
  }

  async load(key: string, token: string, sheet: PreviewSheet) {
    const request = { controller: new AbortController(), key, sheet };
    this.request = request;
    try {
      const replay = this.readReplay!();
      const fetcher = replay.backend?.fetch?.bind(replay.backend) || nativeFetch;
      const response = await fetcher(`/replay/${token}/preview.jpg?at=${sheet.start}&frames=${sheet.count}`, {
        signal: request.controller.signal,
        cache: 'no-store',
        priority: 'low',
      });
      if (!response.ok || !response.headers.get('Content-Type')?.startsWith('image/jpeg'))
        throw new Error('Preview unavailable');
      const blob = await response.blob();
      if (request.controller.signal.aborted || token !== this.token || this.hidden) return;
      const retained = this.retainedBounds(this.readReplay!());
      if (
        sheet.start < retained.start ||
        (retained.precise && sheet.start + (sheet.count - 1) * PREVIEW_INTERVAL >= retained.end)
      )
        return;
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
    cancelTimeout(this.requestTimer);
    this.requestTimer = null;
    this.request?.controller.abort();
    this.request = null;
    cancelInterval(this.clockTimer);
    this.clockTimer = null;
    if (visible) this.emit('scrub-preview-end');
  }

  reset() {
    this.hide();
    for (const bitmap of this.bitmaps?.values() || []) bitmap.close?.();
    this.bitmaps?.clear();
    this.bitmapBytes = 0;
    this.failures?.clear();
    this.context?.clearRect(0, 0, PREVIEW_WIDTH, PREVIEW_HEIGHT);
    this.painted = false;
    this.displayed = null;
    this.point = null;
    this.sheet = null;
    this.token = null;
  }

  override disconnectedCallback() {
    this.reset();
    if (this.changed) this.history?.listeners.delete(this.changed);
    super.disconnectedCallback();
  }
}
