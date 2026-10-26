import { nativeFetch } from '../../../backend-contracts/src/index.js';
import type { Backend, BackendEvents, BackendListener } from '../../../backend-contracts/src/index.js';
const MEDIA_KEYS = new Set([
  'playlist_url',
  'video_url',
  'jpeg_url',
  'frame_url',
  'preview_url',
  'media_url',
]);

export const PYTHON_CAPABILITIES = Object.freeze({
  discovery: true,
  configuration: true,
  telemetry: true,
  serverDvr: true,
  previewFallback: true,
  casting: true,
  localMedia: false,
});

export class PythonBackend implements Backend {
  readonly id = 'python';
  readonly label = 'Python backend';
  readonly origin: string;
  readonly capabilities = PYTHON_CAPABILITIES;
  private readonly fetcher: typeof fetch;
  private readonly eventSource: (url: string) => EventSource;
  constructor(
    origin: string,
    {
      fetcher = nativeFetch,
      eventSource = (url: string) => new EventSource(url),
    }: { fetcher?: typeof fetch; eventSource?: (url: string) => EventSource } = {},
  ) {
    this.id = 'python';
    this.label = 'Python backend';
    this.origin = new URL(origin).origin;
    this.capabilities = PYTHON_CAPABILITIES;
    this.fetcher = fetcher;
    this.eventSource = eventSource;
  }

  resolve(path: string) {
    const url = new URL(path, this.origin);
    if (url.origin !== this.origin || url.username || url.password)
      throw new TypeError('Unexpected backend origin.');
    return url.href;
  }

  payload(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((item) => this.payload(item));
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        MEDIA_KEYS.has(key) && typeof item === 'string' && item ? this.resolve(item) : this.payload(item),
      ]),
    );
  }

  async fetch(path: string, init: RequestInit = {}) {
    // Preserve an installation's same-origin reverse-proxy login while keeping
    // cookies/HTTP auth out of a separately selected backend origin.
    // A redirect must not replay a printer access code at an unselected origin.
    const response = await this.fetcher(this.resolve(path), {
      ...init,
      credentials: 'same-origin',
      redirect: 'error',
    });
    if (!response.headers?.get('Content-Type')?.startsWith('application/json')) return response;
    const headers = new Headers(response.headers);
    headers.delete('Content-Length');
    return new Response(JSON.stringify(this.payload(await response.json())), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  events(path: string): BackendEvents {
    const source = this.eventSource(this.resolve(path));
    const payload = (value: unknown) => this.payload(value);
    return {
      get readyState() {
        return source.readyState;
      },
      set onerror(listener: ((event: Event) => void) | null) {
        source.onerror = listener;
      },
      addEventListener(kind: string, listener: BackendListener) {
        source.addEventListener(kind, (event) => {
          if (kind !== 'state') return listener({});
          let data;
          try {
            data = JSON.stringify(payload(JSON.parse((event as MessageEvent<string>).data)));
          } catch (_) {
            /* Malformed state is ignored until the next snapshot. */
          }
          if (data) listener({ data });
        });
      },
      dispatchEvent(event: Event) {
        return source.dispatchEvent(event);
      },
      close() {
        source.close();
      },
    };
  }
}
