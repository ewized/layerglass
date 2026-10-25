const MEDIA_KEYS = new Set(['playlist_url', 'video_url', 'jpeg_url', 'frame_url', 'preview_url', 'media_url']);

export const PYTHON_CAPABILITIES = Object.freeze({ discovery: true, configuration: true,
  telemetry: true, serverDvr: true, previewFallback: true, casting: true, localMedia: false });

export class PythonBackend {
  constructor(origin, { fetcher = (...args) => fetch(...args), eventSource = url => new EventSource(url) } = {}) {
    this.id = 'python';
    this.label = 'Python backend';
    this.origin = new URL(origin).origin;
    this.capabilities = PYTHON_CAPABILITIES;
    this.fetcher = fetcher;
    this.eventSource = eventSource;
  }

  resolve(path) {
    const url = new URL(path, this.origin);
    if (url.origin !== this.origin || url.username || url.password) throw new TypeError('Unexpected backend origin.');
    return url.href;
  }

  payload(value) {
    if (Array.isArray(value)) return value.map(item => this.payload(item));
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) =>
      [key, MEDIA_KEYS.has(key) && item ? this.resolve(item) : this.payload(item)]));
  }

  async fetch(path, init = {}) {
    // Preserve an installation's same-origin reverse-proxy login while keeping
    // cookies/HTTP auth out of a separately selected backend origin.
    const response = await this.fetcher(this.resolve(path), { ...init, credentials: 'same-origin' });
    if (!response.headers?.get('Content-Type')?.startsWith('application/json')) return response;
    const headers = new Headers(response.headers);
    headers.delete('Content-Length');
    return new Response(JSON.stringify(this.payload(await response.json())), {
      status: response.status, statusText: response.statusText, headers,
    });
  }

  events(path) {
    const source = this.eventSource(this.resolve(path));
    const provider = this;
    return {
      get readyState() { return source.readyState; },
      set onerror(listener) { source.onerror = listener; },
      addEventListener(kind, listener) {
        source.addEventListener(kind, event => {
          if (kind !== 'state') return listener(event);
          let data;
          try { data = JSON.stringify(provider.payload(JSON.parse(event.data))); }
          catch (_) { /* Malformed state is ignored until the next snapshot. */ }
          if (data) listener({ data });
        });
      },
      dispatchEvent(event) { return source.dispatchEvent(event); },
      close() { source.close(); },
    };
  }
}
