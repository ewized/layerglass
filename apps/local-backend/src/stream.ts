import { nativeFetch } from '../../backend-contracts/src/index.js';
import { cancelTimeout } from '../../backend-contracts/src/index.js';
import { errorName, errorMessage } from '../../backend-contracts/src/index.js';
// MJPEG keeps one HTTP response open. JPEG decoding remains browser-owned in
// the existing image element; this module only separates multipart frames.
const MAX_FRAME = 2 * 1024 * 1024;
const MAX_HEADERS = 8192;
const encoder = new TextEncoder();
const separator = encoder.encode('\r\n\r\n');

function indexOf(bytes: Uint8Array, needle: Uint8Array) {
  outer: for (let offset = 0; offset <= bytes.length - needle.length; offset++) {
    for (let index = 0; index < needle.length; index++)
      if (bytes[offset + index] !== needle[index]) continue outer;
    return offset;
  }
  return -1;
}

export class MultipartJpegDecoder {
  private readonly marker: Uint8Array;
  private readonly delimiter: Uint8Array;
  private readonly frame: (frame: Uint8Array<ArrayBuffer>) => void;
  private buffer: Uint8Array<ArrayBuffer>;
  private state: 'boundary' | 'headers' | 'frame';
  private done: boolean;
  private length: number | null = null;
  constructor(contentType: string | null, frame: (frame: Uint8Array<ArrayBuffer>) => void) {
    const match = /^multipart\/x-mixed-replace\s*;\s*boundary=(?:"([^"\r\n]+)"|([^;\s]+))/i.exec(
      contentType || '',
    );
    const boundary = match?.[1] || match?.[2];
    if (!boundary || boundary.length > 128)
      throw new TypeError('The configured webcam did not return an MJPEG stream.');
    this.marker = encoder.encode(`--${boundary}`);
    this.delimiter = encoder.encode(`\r\n--${boundary}`);
    this.frame = frame;
    this.buffer = new Uint8Array();
    this.state = 'boundary';
    this.done = false;
  }

  push(chunk: Uint8Array) {
    if (this.done) return;
    if (this.buffer.length + chunk.length > 2 * MAX_FRAME + MAX_HEADERS)
      throw new Error('The webcam exceeded the MJPEG frame limit.');
    const bytes = new Uint8Array(this.buffer.length + chunk.length);
    bytes.set(this.buffer);
    bytes.set(chunk, this.buffer.length);
    this.buffer = bytes;
    while (!this.done) {
      if (this.state === 'boundary') {
        const position = indexOf(this.buffer, this.marker);
        if (position < 0) {
          if (this.buffer.length > MAX_HEADERS) throw new Error('The webcam returned invalid MJPEG framing.');
          return;
        }
        const end = position + this.marker.length;
        if (this.buffer.length < end + 2) return;
        if (this.buffer[end] === 45 && this.buffer[end + 1] === 45) {
          this.done = true;
          this.buffer = new Uint8Array();
          return;
        }
        if (this.buffer[end] !== 13 || this.buffer[end + 1] !== 10)
          throw new Error('The webcam returned invalid MJPEG framing.');
        this.buffer = this.buffer.subarray(end + 2);
        this.state = 'headers';
      }
      if (this.state === 'headers') {
        const position = indexOf(this.buffer, separator);
        if (position < 0) {
          if (this.buffer.length > MAX_HEADERS)
            throw new Error('The webcam returned oversized MJPEG headers.');
          return;
        }
        if (position > MAX_HEADERS) throw new Error('The webcam returned oversized MJPEG headers.');
        const headers = new TextDecoder().decode(this.buffer.subarray(0, position));
        if (!/^content-type:\s*image\/jpeg\s*$/im.test(headers))
          throw new Error('The webcam returned a non-JPEG MJPEG part.');
        const length = /^content-length:\s*(.*?)\s*$/im.exec(headers)?.[1];
        if (
          length !== undefined &&
          (!/^\d+$/.test(length) || Number(length) < 4 || Number(length) > MAX_FRAME)
        ) {
          throw new Error('The webcam exceeded the MJPEG frame limit.');
        }
        this.length = length === undefined ? null : Number(length);
        this.buffer = this.buffer.subarray(position + separator.length);
        this.state = 'frame';
      }
      if (this.state === 'frame') {
        const length = this.length ?? indexOf(this.buffer, this.delimiter);
        if (length < 0 || this.buffer.length < length) {
          if (this.buffer.length > MAX_FRAME) throw new Error('The webcam exceeded the MJPEG frame limit.');
          return;
        }
        if (length > MAX_FRAME) throw new Error('The webcam exceeded the MJPEG frame limit.');
        const frame = this.buffer.slice(0, length);
        if (frame[0] !== 255 || frame[1] !== 216 || frame.at(-2) !== 255 || frame.at(-1) !== 217) {
          throw new Error('The webcam returned an invalid JPEG frame.');
        }
        this.buffer = this.buffer.subarray(length);
        this.state = 'boundary';
        this.frame(frame);
      }
    }
  }
}

export interface DirectStreamOptions {
  fetcher?: typeof fetch;
  onFrame?: () => void;
  onFailure?: (error: unknown) => void;
  frameTimeout?: number;
}
export class DirectMjpegStream {
  readonly image: HTMLImageElement;
  readonly url: string;
  private readonly fetcher: typeof fetch;
  private readonly onFrame: () => void;
  private readonly onFailure: (error: unknown) => void;
  private readonly frameTimeout: number;
  private readonly controller: AbortController;
  private stopped: boolean;
  private failed: boolean;
  private readonly urls: Set<string>;
  private pending: string | null;
  private current: string | null;
  private queued: Uint8Array<ArrayBuffer> | null;
  private readonly loaded: () => void;
  private readonly decodeFailed: () => void;
  readonly finished: Promise<void>;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private reader: ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>> | null = null;
  contentType: string | null = null;
  failure: { type: string; message: string } | null = null;
  constructor(
    image: HTMLImageElement,
    url: string,
    {
      fetcher = nativeFetch,
      onFrame = () => {},
      onFailure = (_error: unknown) => {},
      frameTimeout = 15000,
    }: DirectStreamOptions = {},
  ) {
    this.image = image;
    this.url = url;
    this.fetcher = fetcher;
    this.onFrame = onFrame;
    this.onFailure = onFailure;
    this.frameTimeout = frameTimeout;
    this.controller = new AbortController();
    this.stopped = false;
    this.failed = false;
    this.urls = new Set();
    this.pending = null;
    this.current = null;
    this.queued = null;
    this.loaded = () => {
      if (this.stopped || this.failed || this.image.src !== this.pending) return;
      if (this.current) this.revoke(this.current);
      this.current = this.pending;
      this.pending = null;
      this.onFrame();
      this.armTimeout();
      if (this.queued) {
        const frame = this.queued;
        this.queued = null;
        this.present(frame);
      }
    };
    this.decodeFailed = () => this.fail(new Error('The browser could not decode the webcam JPEG.'));
    image.addEventListener('load', this.loaded);
    image.addEventListener('error', this.decodeFailed);
    this.finished = this.start();
  }

  revoke(url: string) {
    URL.revokeObjectURL(url);
    this.urls.delete(url);
  }

  armTimeout() {
    cancelTimeout(this.timer);
    this.timer = setTimeout(
      () => this.fail(new Error('The webcam stopped sending live frames.')),
      this.frameTimeout,
    );
  }

  present(bytes: Uint8Array<ArrayBuffer>) {
    if (this.stopped || this.failed) return;
    // A slow decoder keeps only the newest pending frame, rather than building
    // a playback queue or retaining recording data in memory/IndexedDB.
    if (this.pending) {
      this.queued = bytes;
      return;
    }
    this.pending = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
    this.urls.add(this.pending);
    this.image.src = this.pending;
  }

  async start() {
    this.armTimeout();
    try {
      const response = await this.fetcher(this.url, {
        method: 'GET',
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
        signal: this.controller.signal,
      });
      if (this.stopped || this.failed) {
        await response.body?.cancel();
        return;
      }
      if (!response.ok || !response.body) throw new Error('The direct webcam stream is unavailable.');
      this.contentType = response.headers.get('Content-Type');
      const decoder = new MultipartJpegDecoder(response.headers.get('Content-Type'), (bytes) =>
        this.present(bytes),
      );
      this.reader = response.body.getReader();
      while (!this.stopped && !this.failed) {
        const { done, value } = await this.reader.read();
        if (done) throw new Error('The direct webcam stream ended.');
        decoder.push(value);
      }
    } catch (error) {
      if (!this.stopped && !this.failed) this.fail(error);
    } finally {
      await this.reader?.cancel().catch(() => {});
      this.reader?.releaseLock();
      this.reader = null;
    }
  }

  fail(error: unknown) {
    if (this.failed || this.stopped) return;
    this.failed = true;
    this.failure = { type: errorName(error), message: errorMessage(error) };
    cancelTimeout(this.timer);
    this.controller.abort();
    this.onFailure(error);
  }

  destroy() {
    if (this.stopped) return;
    this.stopped = true;
    cancelTimeout(this.timer);
    this.controller.abort();
    this.image.removeEventListener('load', this.loaded);
    this.image.removeEventListener('error', this.decodeFailed);
    if (this.urls.has(this.image.src)) this.image.removeAttribute('src');
    for (const url of this.urls) URL.revokeObjectURL(url);
    this.urls.clear();
    this.pending = null;
    this.current = null;
    this.queued = null;
  }
}
