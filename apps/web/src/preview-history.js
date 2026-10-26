import { PreviewStorage } from './preview-storage.js';
import { playerVisible } from './visibility.js';

export const PREVIEW_INTERVAL = 5;
export const PREVIEW_WIDTH = 320;
export const PREVIEW_HEIGHT = 180;

function lowerBound(keys, value) {
  let low = 0, high = keys.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (keys[mid] < value) low = mid + 1;
    else high = mid;
  }
  return low;
}

// Keep compressed blobs, never an entire session of decoded video/image frames.
// IndexedDB backs the bounded RAM cache; only the few visible images are decoded.
export class PreviewHistory {
  constructor({ disk = new PreviewStorage(), maxBytes = 32 * 1024 * 1024, maxFrames = 17280 } = {}) {
    Object.assign(this, { disk, maxBytes, maxFrames });
    this.frames = new Map();
    this.assets = new Map();
    this.hot = new Map();
    this.keys = [];
    this.bytes = 0;
    this.version = 0;
    this.pending = new Map();
    this.writes = new Set();
    this.listeners = new Set();
  }

  setSession(session) {
    const token = session?.session_id || null;
    if (token === this.token) return;
    const previous = this.token;
    this.version++;
    this.token = token;
    this.frames.clear(); this.assets.clear(); this.hot.clear(); this.keys = [];
    this.bytes = 0;
    this.pending.clear();
    this.captured = this.server = this.memoryHits = this.diskHits = 0;
    if (previous) this.disk?.removeSession(previous);
  }

  touch(asset) {
    if (!asset.blob) return;
    this.hot.delete(asset.key);
    this.hot.set(asset.key, asset);
  }

  forgetFrame(key) {
    const frame = this.frames.get(key);
    if (!frame) return;
    this.frames.delete(key);
    this.keys.splice(lowerBound(this.keys, key), 1);
    const asset = this.assets.get(frame.asset);
    asset?.refs.delete(key);
    if (!asset || asset.refs.size) return;
    this.assets.delete(asset.key);
    if (this.hot.delete(asset.key)) this.bytes -= asset.size;
    this.disk?.remove(this.token, asset.key);
  }

  trim(start) {
    for (const key of [...this.keys]) {
      if (this.frames.get(key).time < start) this.forgetFrame(key);
      else break;
    }
  }

  evict() {
    while (this.bytes > this.maxBytes && this.hot.size) {
      const [key, asset] = this.hot.entries().next().value;
      this.hot.delete(key);
      this.bytes -= asset.size;
      asset.blob = null;
      if (!asset.persisted && !asset.writing) for (const frame of [...asset.refs]) this.forgetFrame(frame);
    }
    while (this.keys.length > this.maxFrames) this.forgetFrame(this.keys[0]);
  }

  add({ key, blob, frames, columns = 1, rows = 1, capture = false }) {
    if (!this.token || !blob?.size || this.assets.has(key)) return null;
    const accepted = frames.filter(frame => capture || !this.frames.get(frame.bucket)?.capture);
    if (!accepted.length) return null;
    const asset = { key, blob, size: blob.size, columns, rows, refs: new Set(),
      writing: Boolean(this.disk && this.writes.size < 8), persisted: false };
    this.assets.set(key, asset);
    for (const frame of accepted) {
      this.forgetFrame(frame.bucket);
      this.frames.set(frame.bucket, { ...frame, asset: key, capture });
      this.keys.splice(lowerBound(this.keys, frame.bucket), 0, frame.bucket);
      asset.refs.add(frame.bucket);
    }
    this.bytes += blob.size;
    this.touch(asset);
    if (capture) this.captured++; else this.server++;
    this.evict();
    if (asset.writing) {
      const token = this.token, version = this.version;
      const write = this.disk.put({ session: token, key, blob, columns, rows, frames: accepted }).catch(() => false);
      this.writes.add(write);
      write.then(saved => {
        asset.writing = false;
        if (version !== this.version || this.assets.get(key) !== asset) {
          if (saved) this.disk.remove(token, key);
          return;
        }
        asset.persisted = saved;
        if (!saved && !asset.blob) for (const frame of [...asset.refs]) this.forgetFrame(frame);
      }).finally(() => this.writes.delete(write));
    }
    for (const listener of this.listeners) listener();
    return asset;
  }

  addFrame(time, blob) {
    const bucket = Math.floor(time / PREVIEW_INTERVAL) * PREVIEW_INTERVAL;
    if (this.frames.get(bucket)?.capture) return null;
    return this.add({ key: 'frame:' + bucket, blob, capture: true, frames: [{ bucket, time, cell: 0 }] });
  }

  addSheet(sheet, blob) {
    return this.add({ key: 'sheet:' + sheet.start + ':' + sheet.count, blob, columns: 3, rows: 2,
      frames: Array.from({ length: sheet.count }, (_, cell) => {
        const time = sheet.start + cell * PREVIEW_INTERVAL;
        return { bucket: Math.floor(time / PREVIEW_INTERVAL) * PREVIEW_INTERVAL, time, cell };
      }) });
  }

  nearest(time, distance = PREVIEW_INTERVAL, memoryOnly = false) {
    const index = lowerBound(this.keys, Math.floor(time / PREVIEW_INTERVAL) * PREVIEW_INTERVAL);
    let best = null;
    // Samples are in five-second buckets; include the following bucket too.
    for (const at of [index - 1, index, index + 1]) {
      const frame = this.frames.get(this.keys[at]);
      const asset = frame && this.assets.get(frame.asset);
      if (!asset || memoryOnly && !asset.blob || Math.abs(frame.time - time) > distance) continue;
      if (!best || Math.abs(frame.time - time) < Math.abs(best.frame.time - time)) best = { frame, asset };
    }
    if (!best && memoryOnly && distance === Infinity) {
      for (const asset of this.hot.values()) for (const key of asset.refs) {
        const frame = this.frames.get(key);
        if (!best || Math.abs(frame.time - time) < Math.abs(best.frame.time - time)) best = { frame, asset };
      }
    }
    return best;
  }

  peek(time, distance = PREVIEW_INTERVAL) {
    const found = this.nearest(time, distance, true);
    if (found) { this.touch(found.asset); this.memoryHits++; }
    return found;
  }

  async get(time, distance = PREVIEW_INTERVAL) {
    const found = this.nearest(time, distance);
    // A nearby resident placeholder must not hide a closer persisted frame.
    if (found?.asset.blob) {
      this.touch(found.asset);
      this.memoryHits++;
      return found;
    }
    if (!found?.asset.persisted || !this.disk) return null;
    const { asset } = found;
    const version = this.version;
    let pending = this.pending.get(asset.key);
    if (!pending) {
      pending = this.disk.get(this.token, asset.key).catch(() => null);
      this.pending.set(asset.key, pending);
    }
    const stored = await pending;
    if (this.pending.get(asset.key) === pending) this.pending.delete(asset.key);
    if (version !== this.version || this.assets.get(asset.key) !== asset) return null;
    if (!stored?.blob) {
      for (const key of [...asset.refs]) this.forgetFrame(key);
      return null;
    }
    if (!asset.blob) { asset.blob = stored.blob; this.bytes += asset.size; }
    this.touch(asset);
    this.diskHits++;
    this.evict();
    // A very small RAM budget can evict the just-read blob; this one paint may
    // still use it without raising the persistent RAM limit.
    return { frame: found.frame, asset: { ...asset, blob: stored.blob } };
  }

  diagnostics() {
    return { frames: this.frames.size, captured: this.captured, server_sheets: this.server,
      memory_bytes: this.bytes, memory_limit: this.maxBytes, disk_available: this.disk?.available ?? false,
      memory_hits: this.memoryHits, disk_hits: this.diskHits };
  }
}

// One already-decoded frame every five seconds. A one-shot frame callback
// follows a timeupdate gate; there is no per-frame JavaScript animation loop.
export class PreviewCapture {
  constructor(history, video, image, readReplay) {
    Object.assign(this, { history, video, image, readReplay });
    this.events = new AbortController();
    const listen = (target, name, handler) => target.addEventListener(name, handler, { signal: this.events.signal });
    for (const event of ['timeupdate', 'loadeddata', 'seeked', 'pause']) listen(video, event, () => this.sample());
    listen(image, 'load', () => this.sample());
    listen(image, 'replayimagechange', () => { this.cancel(); this.sample(); });
    listen(video, 'emptied', () => this.cancel());
    listen(video.ownerDocument, 'visibilitychange', () => { if (!playerVisible()) this.cancel(); else this.sample(); });
    listen(video.ownerDocument.defaultView, 'pagehide', () => { this.cancel(); history.disk?.suspend?.(); });
    listen(video.ownerDocument.defaultView, 'pageshow', () => { history.disk?.resume?.(); this.sample(); });
  }

  sample() {
    const replay = this.readReplay();
    const session = replay.session;
    if (!session?.ready || session.session_id !== this.history.token || replay.remote || !playerVisible() ||
        this.pending || this.unavailable || performance.now() - (this.lastAttempt ?? -Infinity) < 1000) return;
    const source = this.image.hidden ? this.video : this.image;
    const imageFrame = source === this.image ? replay.decodedImage?.() : null;
    const time = source === this.video ? this.video.currentTime : imageFrame?.position;
    const bucket = Math.floor(time / PREVIEW_INTERVAL) * PREVIEW_INTERVAL;
    if (!Number.isFinite(time) || time < (imageFrame ? replay.jpegDescriptor?.()?.start ?? session.start_seconds : session.start_seconds) || this.history.frames.get(bucket)?.capture ||
        source === this.video && (this.video.seeking || this.video.readyState < 2) ||
        !(source === this.video ? source.videoWidth : source.naturalWidth)) return;
    this.lastAttempt = performance.now();
    this.pending = true;
    const job = this.job = (this.job || 0) + 1;
    const version = this.history.version;
    if (source === this.video && !this.video.paused && typeof this.video.requestVideoFrameCallback === 'function') {
      this.callback = this.video.requestVideoFrameCallback((_now, metadata) => {
        this.callback = null;
        this.save(source, metadata.mediaTime, session.session_id, version, job);
      });
      this.deadline = setTimeout(() => this.cancel(), 700);
    } else this.save(source, time, session.session_id, version, job, imageFrame);
  }

  save(source, time, token, version, job, imageFrame = null) {
    if (job !== this.job) return;
    clearTimeout(this.deadline);
    try {
      const replay = this.readReplay(), session = replay.session;
      if (token !== this.history.token || version !== this.history.version || !session ||
          !Number.isFinite(time) || time < (imageFrame ? replay.jpegDescriptor?.()?.start ?? session.start_seconds : session.start_seconds) || !playerVisible() ||
          source === this.image && (!imageFrame || replay.decodedImage?.() !== imageFrame) ||
          source === this.video && (this.video.seeking || this.video.readyState < 2)) { this.pending = false; return; }
      this.canvas ??= this.video.ownerDocument.createElement('canvas');
      this.canvas.width = PREVIEW_WIDTH;
      this.canvas.height = PREVIEW_HEIGHT;
      this.context ??= this.canvas.getContext('2d', { alpha: false });
      if (!this.context) { this.unavailable = true; this.pending = false; return; }
      const width = source === this.video ? source.videoWidth : source.naturalWidth;
      const height = source === this.video ? source.videoHeight : source.naturalHeight;
      const scale = Math.min(PREVIEW_WIDTH / width, PREVIEW_HEIGHT / height);
      this.context.fillStyle = '#000';
      this.context.fillRect(0, 0, PREVIEW_WIDTH, PREVIEW_HEIGHT);
      this.context.drawImage(source, (PREVIEW_WIDTH - width * scale) / 2, (PREVIEW_HEIGHT - height * scale) / 2, width * scale, height * scale);
      this.posterTime = time;
      this.posterToken = token;
      this.canvas.toBlob(blob => {
        if (job !== this.job) return;
        this.pending = false;
        if (blob && token === this.history.token && version === this.history.version &&
            (source !== this.image || this.readReplay().decodedImage?.() === imageFrame)) this.history.addFrame(time, blob);
      }, 'image/jpeg', 0.6);
    } catch (error) {
      this.pending = false;
      if (error.name === 'SecurityError') this.unavailable = true;
    }
  }

  cancel() {
    this.job = (this.job || 0) + 1;
    clearTimeout(this.deadline);
    if (this.callback !== null && this.callback !== undefined) this.video.cancelVideoFrameCallback?.(this.callback);
    this.callback = null;
    this.pending = false;
  }

  close() { this.cancel(); this.events.abort(); }

  reset() { this.cancel(); this.unavailable = false; this.posterToken = null; this.lastAttempt = -Infinity; }
}
