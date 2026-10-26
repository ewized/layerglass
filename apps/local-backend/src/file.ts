import { cancelTimeout, cancelInterval } from '../../backend-contracts/src/index.js';
import { isFiniteNumber } from '../../backend-contracts/src/index.js';
import { isRecord, parseJson } from '../../backend-contracts/src/index.js';
import type {
  Backend,
  BackendCapabilities,
  BackendEvents,
  BackendListener,
  CameraCatalog,
  StreamStatus,
  ReplaySession,
  TelemetryWindow,
  BackendSnapshot,
  PrinterTelemetry,
} from '../../backend-contracts/src/index.js';
// Browser-owned files have a page-scoped clock and no printer telemetry.
export const LOCAL_FILE_CAPABILITIES = Object.freeze({
  discovery: false,
  configuration: false,
  telemetry: false,
  serverDvr: false,
  previewFallback: false,
  casting: false,
  localMedia: true,
});
const json = (body: unknown, status = 200) => Response.json(body, { status });

export interface FileOptions {
  clock?: () => number;
  duration?: number;
  media?: string | null;
  camera?: string;
}
export class LocalFileBackend implements Backend {
  id: Backend['id'];
  label: string;
  capabilities: BackendCapabilities;
  clock: () => number;
  duration: number;
  media: string | null;
  camera: string;
  started: number;
  sessions: Map<string, boolean>;
  generation: number;
  local: boolean;
  localURL?: string;
  constructor({
    clock = () => Date.now() / 1000,
    duration = Infinity,
    media = null,
    camera = 'de00000000000001',
  }: FileOptions = {}) {
    this.id = 'local';
    this.label = 'Local video';
    this.capabilities = LOCAL_FILE_CAPABILITIES;
    this.clock = clock;
    this.duration = duration;
    this.media = media;
    this.camera = camera;
    this.started = clock();
    this.sessions = new Map();
    this.generation = 0;
    this.local = true;
  }

  resolve(path: string) {
    return path;
  }
  elapsed() {
    return Math.max(0, Math.min(this.duration, this.clock() - this.started));
  }
  async prepareMedia() {
    return this.media;
  }

  setLocalMedia(file: Blob) {
    if (this.localURL) URL.revokeObjectURL(this.localURL);
    this.media = this.localURL = URL.createObjectURL(file);
    this.duration = Infinity;
    this.started = this.clock();
    this.generation++;
    this.local = true;
    this.capabilities = LOCAL_FILE_CAPABILITIES;
  }

  setDuration(duration: number) {
    if (isFiniteNumber(duration) && duration > 0) this.duration = duration;
  }

  printer(_at?: number): PrinterTelemetry {
    return { state: 'unsupported', message: 'Local video has no printer telemetry.' };
  }
  catalog(): CameraCatalog {
    return {
      default_camera_id: this.camera,
      cameras: [
        {
          id: this.camera,
          name: 'Local video',
          model_name: 'Local video',
          serial: '',
          configured: true,
          discovered: false,
          setup: { type: 'none' },
        },
      ],
      discovery: { state: 'done', networks: [], cameras: [], checked: 0, total: 0 },
    };
  }
  status(): StreamStatus {
    return {
      camera_id: this.camera,
      state: 'live',
      generation: `local-file-${this.generation}`,
      message: 'Local video. No printer is connected.',
      media_url: this.media,
      printer: this.printer(),
    };
  }
  session(token: string | null): ReplaySession | null {
    if (!token || !this.sessions.has(token)) return null;
    return {
      session_id: token,
      camera_id: this.camera,
      kind: 'file',
      ready: true,
      media_url: this.media,
      start_seconds: 0,
      end_seconds: this.elapsed(),
      clock: [{ position: 0, time: this.started }],
      error: null,
      limited: false,
      preview_fallback: false,
      telemetry: this.capabilities.telemetry,
      demo: !this.local,
    };
  }

  history(_token: string, _at?: number, _options?: { fromStart?: boolean }): TelemetryWindow | null {
    return null;
  }

  snapshot(path: string, { fromStart = true } = {}): BackendSnapshot {
    const query = new URL(path, 'http://demo.invalid').searchParams;
    const token = query.get('session');
    return {
      version: 1,
      catalog: this.catalog(),
      status: this.status(),
      session_id: token,
      replay: this.session(token),
      ...(this.session(token) ? { telemetry: this.history(token!, this.clock(), { fromStart }) } : {}),
    };
  }

  async fetch(path: string, init: RequestInit = {}) {
    if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const url = new URL(path, 'http://demo.invalid');
    const method = init.method || 'GET';
    if (method === 'GET' && url.pathname === '/api/cameras') return json(this.catalog());
    if (method === 'GET' && url.pathname === '/api/status') return json(this.status());
    if (method === 'GET' && url.pathname === '/api/snapshot') return json(this.snapshot(path));
    if (method === 'POST' && url.pathname === '/api/sessions') {
      const body = typeof init.body === 'string' ? parseJson(init.body) : null;
      const camera = isRecord(body) ? body.camera_id : null;
      if (camera !== this.camera) return json({ error: 'This source has no network printers.' }, 404);
      const token = crypto.randomUUID().replaceAll('-', '');
      this.sessions.set(token, true);
      return json(this.session(token));
    }
    const match = /^\/api\/sessions\/([a-f0-9]{32})(?:\/(printer|close))?$/.exec(url.pathname);
    if (match) {
      if (method === 'POST' && match[2] === 'close') {
        this.sessions.delete(match[1]!);
        return json({ ok: true });
      }
      const body =
        match[2] === 'printer'
          ? this.history(match[1]!, Number(url.searchParams.get('at')))
          : this.session(match[1]!);
      return json(body || { error: 'Video session expired.' }, body ? 200 : 404);
    }
    return json({ error: 'This feature requires the optional Python backend.' }, 501);
  }

  events(path: string): BackendEvents {
    const listeners = new Map<string, Set<BackendListener>>();
    const emit = (fromStart: boolean) => {
      const event = { data: JSON.stringify(this.snapshot(path, { fromStart })) };
      for (const listener of listeners.get('state') || []) listener(event);
    };
    // Seed the existing history/event pipeline once per subscription, then
    // retain its normal small update windows rather than replaying the seed.
    const initial = setTimeout(() => emit(true), 0);
    const timer = setInterval(() => emit(false), 1000);
    return {
      readyState: 1,
      addEventListener(name: string, listener: BackendListener) {
        if (!listeners.has(name)) listeners.set(name, new Set());
        listeners.get(name)!.add(listener);
      },
      close() {
        cancelTimeout(initial);
        cancelInterval(timer);
        listeners.clear();
      },
    };
  }
}
