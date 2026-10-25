import Hls from './vendor/hls.min.mjs';
import { playerVisible } from './visibility.js';

// Video travels as binary records in one HTTP response. hls.js still handles
// timestamps, transmuxing and seeks; native video decodes and renders. The
// loaders read pushed data from this cache.
// Framing: BCV1, then [uint32 JSON length, uint32 media length, JSON, media].
export class VideoRecords {
  constructor(reader) { this.reader = reader; this.chunk = null; this.offset = 0; }

  async read(size) {
    const data = new Uint8Array(size);
    let offset = 0;
    while (offset < size) {
      if (!this.chunk || this.offset === this.chunk.length) {
        const result = await this.reader.read();
        if (result.done) throw new Error('Video connection ended');
        this.chunk = result.value;
        this.offset = 0;
        if (!this.chunk.length) continue;
      }
      const count = Math.min(size - offset, this.chunk.length - this.offset);
      data.set(this.chunk.subarray(this.offset, this.offset + count), offset);
      this.offset += count;
      offset += count;
    }
    return data;
  }

  async open() {
    if (new TextDecoder().decode(await this.read(4)) !== 'BCV1') throw new Error('Unsupported video stream');
  }

  async next() {
    const sizes = new DataView((await this.read(8)).buffer);
    const headerSize = sizes.getUint32(0);
    const mediaSize = sizes.getUint32(4);
    if (headerSize < 2 || headerSize > 8 * 1024 * 1024 || mediaSize > 32 * 1024 * 1024) {
      throw new Error('Invalid video record size');
    }
    const header = JSON.parse(new TextDecoder().decode(await this.read(headerSize)));
    if (!header || !['index', 'update', 'segment', 'heartbeat'].includes(header.type) ||
        (mediaSize && header.type !== 'segment')) throw new Error('Invalid video record');
    return { header, data: await this.read(mediaSize) };
  }
}

export class PlayerVideoStream {
  static supported(session) {
    return Boolean(session?.video_url && Hls.isSupported() &&
      window.fetch && window.ReadableStream && window.AbortController);
  }

  constructor(session, onFailure, options = {}) {
    this.url = session.video_url;
    this.base = new URL(session.playlist_url, location.href);
    this.onFailure = onFailure;
    this.failureLimit = options.failureLimit ?? 3;
    this.quiet = options.quiet ?? false;
    this.fetcher = options.backend?.fetch?.bind(options.backend) || ((...args) => fetch(...args));
    this.maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
    this.maxSegments = options.maxSegments ?? 24;
    this.cache = new Map();
    this.segments = new Map();
    this.listeners = new Set();
    this.bytes = 0;
    this.receivedBytes = 0;
    this.version = 0;
    this.failures = 0;
    this.connected = false;
    this.destroyed = false;
    this.pageHidden = false;
    this.suspended = !playerVisible() || globalThis.navigator?.onLine === false;
    this.nextSequence = null;
    this.requested = null;
    this.index = null;
    this.onVisibility = () => {
      this.suspended = !playerVisible() || this.pageHidden || globalThis.navigator?.onLine === false;
      if (this.suspended) this.disconnect();
      else if (!this.controller) this.connect(this.requested);
    };
    this.onPageHide = () => { this.pageHidden = true; this.suspended = true; this.disconnect(); };
    this.onPageShow = () => { this.pageHidden = false; this.onVisibility(); };
    this.onOnline = () => this.onVisibility();
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('playerviewchange', this.onVisibility);
    window.addEventListener('pagehide', this.onPageHide, true);
    window.addEventListener('pageshow', this.onPageShow);
    window.addEventListener('online', this.onOnline);
    window.addEventListener('offline', this.onVisibility);
    this.connect(null);
  }

  disconnect() {
    this.version++;
    clearTimeout(this.retryTimer);
    clearTimeout(this.watchdog);
    this.controller?.abort();
    this.controller = null;
    this.connected = false;
  }

  destroy() {
    this.destroyed = true;
    this.disconnect();
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('playerviewchange', this.onVisibility);
    window.removeEventListener('pagehide', this.onPageHide, true);
    window.removeEventListener('pageshow', this.onPageShow);
    window.removeEventListener('online', this.onOnline);
    window.removeEventListener('offline', this.onVisibility);
    this.cache.clear();
    this.segments.clear();
    this.bytes = 0;
    this.notify();
  }

  async connect(start) {
    this.disconnect();
    if (this.destroyed || this.suspended) return;
    const version = this.version;
    const controller = this.controller = new AbortController();
    this.nextSequence = start;
    const began = performance.now();
    const resetWatchdog = (delay = 35000) => {
      clearTimeout(this.watchdog);
      this.watchdog = setTimeout(() => controller.abort(), delay);
    };
    // Detect a buffering proxy before the player stall watchdog reattaches.
    // Once frames arrive, allow the regular fifteen-second heartbeat interval.
    resetWatchdog(4000);
    let reader;
    try {
      const url = new URL(this.url, location.href);
      if (Number.isSafeInteger(start) && start >= 0) url.searchParams.set('start', start);
      const response = await this.fetcher(url, { signal: controller.signal, cache: 'no-store' });
      if (!response.ok || !response.body?.getReader) throw new Error('Video streaming unavailable');
      reader = response.body.getReader();
      // Observe failures on both read() and closed, then release buffered
      // chunks on exit (including when a tab disappears during a fetch).
      reader.closed.catch(() => {});
      const records = new VideoRecords(reader);
      await records.open();
      while (version === this.version && !this.destroyed) {
        const { header, data } = await records.next();
        if (version !== this.version) return;
        resetWatchdog();
        this.connected = true;
        if (performance.now() - began > 30000) this.failures = 0;
        this.accept(header, data);
        // Successful media between disconnects makes them separate outages,
        // rather than three consecutive failures of the streaming protocol.
        if (header.type === 'segment') this.failures = 0;
      }
    } catch (error) {
      if (version !== this.version || this.destroyed || this.suspended) return;
      this.connected = false;
      clearTimeout(this.watchdog);
      this.controller = null;
      if (++this.failures >= this.failureLimit) {
        if (!this.quiet) console.warn('[Layerglass] Continuous video unavailable; using HLS delivery');
        this.onFailure();
        return;
      }
      if (!this.quiet) console.info('[Layerglass] Reconnecting continuous video');
      this.retryTimer = setTimeout(() => this.connect(this.requested), 1000 * 2 ** (this.failures - 1));
    } finally {
      if (reader) {
        try { await reader.cancel(); } catch (_) { /* The response may already have failed. */ }
        reader.releaseLock();
      }
    }
  }

  accept(header, data) {
    if (header.type === 'index' || header.type === 'update') {
      if (!Array.isArray(header.segments) || !Number.isSafeInteger(header.start) ||
          !Number.isSafeInteger(header.first) || !Number.isFinite(header.target) || header.target <= 0) {
        throw new Error('Invalid video index');
      }
      if (header.type === 'index') this.segments.clear();
      for (const item of header.segments) {
        if (!Number.isSafeInteger(item.sequence) || !Number.isFinite(item.duration) || item.duration <= 0) {
          throw new Error('Invalid video segment');
        }
        this.segments.set(item.sequence, item);
      }
      this.index = header;
      for (const sequence of this.segments.keys()) {
        if (sequence < header.start) this.segments.delete(sequence);
      }
      for (const [sequence, bytes] of this.cache) {
        if (!this.segments.has(sequence)) { this.bytes -= bytes.byteLength; this.cache.delete(sequence); }
      }
    } else if (header.type === 'segment') {
      if (!Number.isSafeInteger(header.sequence) || !data.byteLength) throw new Error('Invalid video payload');
      this.receivedBytes += data.byteLength;
      const previous = this.cache.get(header.sequence);
      this.bytes += data.byteLength - (previous?.byteLength ?? 0);
      this.cache.delete(header.sequence);
      this.cache.set(header.sequence, data);
      this.nextSequence = header.sequence + 1;
      // Keep one oversized fragment long enough for the decoder to consume it.
      while ((this.bytes > this.maxBytes || this.cache.size > this.maxSegments) && this.cache.size > 1) {
        const [sequence, bytes] = this.cache.entries().next().value;
        this.bytes -= bytes.byteLength;
        this.cache.delete(sequence);
      }
    }
    this.notify();
  }

  notify() { for (const listener of [...this.listeners]) listener(); }

  waitFor(read, signal) {
    return new Promise((resolve, reject) => {
      const finish = () => { this.listeners.delete(check); signal.removeEventListener('abort', abort); };
      const abort = () => { finish(); reject(new DOMException('Aborted', 'AbortError')); };
      const check = () => {
        try {
          if (this.destroyed) throw new Error('Video stream closed');
          const result = read();
          if (result !== null) { finish(); resolve(result); }
        } catch (error) { finish(); reject(error); }
      };
      this.listeners.add(check);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort(); else check();
    });
  }

  playlist(signal) {
    return this.waitFor(() => {
      if (!this.index || !this.segments.size) return null;
      const items = [...this.segments.values()].sort((a, b) => a.sequence - b.sequence);
      const first = items[0];
      const lines = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${this.index.target}`,
        `#EXT-X-MEDIA-SEQUENCE:${first.sequence}`,
        `#EXT-X-DISCONTINUITY-SEQUENCE:${first.discontinuities - Number(first.discontinuity)}`];
      if (first.sequence === this.index.first) lines.push('#EXT-X-PLAYLIST-TYPE:EVENT');
      for (const item of items) {
        if (item.discontinuity) lines.push('#EXT-X-DISCONTINUITY');
        if (item.date) lines.push(`#EXT-X-PROGRAM-DATE-TIME:${item.date}`);
        lines.push(`#EXTINF:${item.duration.toFixed(6)},`, `segment-${item.sequence}.ts`);
      }
      return lines.join('\n') + '\n';
    }, signal);
  }

  segment(sequence, signal) {
    if (this.index && sequence < this.index.start) return Promise.reject(new Error('Footage was trimmed'));
    this.requested = sequence;
    // The next consecutive fragment is already on its way. A forward seek
    // that skips it must reposition even by one fragment: archived delivery
    // is paced, so waiting here would keep Live behind the old replay clock.
    if (!this.cache.has(sequence) && !this.suspended &&
        (!this.controller || (this.nextSequence !== null &&
          (sequence < this.nextSequence || sequence > this.nextSequence)))) this.connect(sequence);
    return this.waitFor(() => {
      if (this.index && sequence < this.index.start) throw new Error('Footage was trimmed');
      // The worker transfers/detaches its ArrayBuffer; retain our own copy.
      return this.cache.has(sequence) ? this.cache.get(sequence).slice().buffer : null;
    }, signal);
  }

  get mediaBitrate() {
    let bytes = 0;
    let seconds = 0;
    for (const [sequence, data] of this.cache) {
      const item = this.segments.get(sequence);
      if (item) { bytes += data.byteLength; seconds += item.duration; }
    }
    return seconds > 0 ? bytes * 8 / seconds : null;
  }

  loader(Hls) {
    const transport = this;
    return class StreamLoader extends Hls.DefaultConfig.loader {
      load(context, config, callbacks) {
        const url = new URL(context.url, location.href);
        const own = url.origin === transport.base.origin &&
          url.pathname.slice(0, url.pathname.lastIndexOf('/') + 1) ===
          transport.base.pathname.slice(0, transport.base.pathname.lastIndexOf('/') + 1);
        const fragment = own && /\/segment-([0-9]+)\.ts$/.exec(url.pathname);
        if (!own || (!fragment && !url.pathname.endsWith('/live.m3u8'))) return super.load(context, config, callbacks);
        this.context = context;
        this.custom = { callbacks, controller: new AbortController(), active: true };
        const custom = this.custom;
        const stats = this.stats;
        stats.loading.start = performance.now();
        custom.timer = setTimeout(() => {
          if (!custom.active) return;
          custom.active = false;
          custom.controller.abort();
          callbacks.onTimeout(stats, context, null);
        }, Math.min(config.loadPolicy?.maxLoadTimeMs || config.timeout || 45000, 45000));
        const result = fragment ? transport.segment(Number(fragment[1]), custom.controller.signal) :
          transport.playlist(custom.controller.signal);
        result.then(data => {
          if (!custom.active) return;
          custom.active = false;
          clearTimeout(custom.timer);
          stats.loading.start = stats.loading.first = stats.loading.end = performance.now();
          stats.loaded = stats.total = typeof data === 'string' ? data.length : data.byteLength;
          stats.chunkCount = 1;
          callbacks.onSuccess({ url: context.url, data, code: 200 }, stats, context, null);
        }, () => {
          if (!custom.active) return;
          custom.active = false;
          clearTimeout(custom.timer);
          callbacks.onError({ code: 0, text: 'Video stream unavailable' }, context, null, stats);
        });
      }

      abort() {
        if (!this.custom) return super.abort();
        if (!this.custom.active) return;
        this.custom.active = false;
        this.stats.aborted = true;
        clearTimeout(this.custom.timer);
        this.custom.controller.abort();
        this.custom.callbacks.onAbort?.(this.stats, this.context, null);
      }

      destroy() {
        this.abort();
        this.custom = null;
        super.destroy();
      }

      getCacheAge() { return 0; }
    };
  }
}
