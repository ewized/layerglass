import { nativeFetch } from '../../backend-contracts/src/index.js';
import { cancelTimeout, cancelInterval } from '../../backend-contracts/src/index.js';
import { isRecord, parseJson, errorMessage } from '../../backend-contracts/src/index.js';
import type {
  Backend,
  BackendEvents,
  BackendListener,
  CameraInfo,
  CameraCatalog,
  StreamStatus,
  BackendSnapshot,
} from '../../backend-contracts/src/index.js';
export interface DirectOptions {
  profile?: 'moonraker';
  fetcher?: typeof fetch;
  page?: string;
  signal?: AbortSignal;
}
export interface DirectIdentity {
  profile: 'moonraker';
  origin: string;
  cameras: CameraInfo[];
  firmware: string;
  hostname: string;
  moonraker_version: string;
}
// An approved browser-only profile for an existing Klipper/Moonraker controller.
// It never accepts arbitrary camera URLs, probes a subnet or sends print commands.
export const DIRECT_CAPABILITIES = Object.freeze({
  discovery: false,
  cameraSelection: true,
  configuration: false,
  telemetry: false,
  serverDvr: false,
  previewFallback: false,
  casting: false,
  localMedia: false,
  liveOnly: true,
});

export const DIRECT_PROFILES = Object.freeze({
  moonraker: Object.freeze({
    name: 'Klipper / Moonraker',
    service: 'mjpegstreamer',
    transport: 'mjpeg',
  }),
});

const json = (body: unknown, status = 200) => Response.json(body, { status });
const text = (value: unknown, limit = 128): value is string =>
  typeof value === 'string' && Boolean(value.trim()) && value.length <= limit;
const states = new Set(['ready', 'startup', 'error', 'shutdown']);

export function directBrowserError(agent = globalThis.navigator?.userAgent || '') {
  // WebKit cancels multipart fetch resources, and its native image loader does
  // not reliably close or report ended MJPEG connections. Do not open a feed
  // that this app cannot safely own. iOS Chrome/Firefox use the same engine.
  if (/AppleWebKit\//.test(agent) && !/Chrome\/|Chromium\/|Edg\//.test(agent)) {
    return 'Direct MJPEG is unavailable in Safari and iPhone browsers. Use the Docker backend, or Chrome / Chromium on desktop or Android.';
  }
  return null;
}

export function directOrigin(value: unknown, page = globalThis.location?.href || 'http://localhost/') {
  let url;
  try {
    url = new URL(typeof value === 'string' ? value : '');
  } catch (_) {
    throw new TypeError('Enter the Moonraker printer/controller HTTP(S) origin.');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new TypeError('Use the printer/controller origin without a path, camera URL or credentials.');
  }
  if (
    new URL(page).protocol === 'https:' &&
    url.protocol !== 'https:' &&
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  ) {
    throw new TypeError(
      'The HTTPS app needs an HTTPS printer/controller. Bambu LAN cameras require the Docker backend.',
    );
  }
  return url.origin;
}

function cameraURL(value: unknown, origin: string) {
  if (!text(value, 2048)) return null;
  let url;
  try {
    url = new URL(value, origin);
  } catch (_) {
    return null;
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.origin !== origin ||
    url.username ||
    url.password ||
    url.hash ||
    [...url.searchParams.keys()].some((key) =>
      /pass(?:word)?|token|key|access.?code|auth|secret|credential/i.test(key),
    )
  )
    return null;
  return url.href;
}

// Stable, non-secret local camera keys use the player's existing 16-hex namespace.
function cameraID(origin: string, uid: string) {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(`${origin}\0${uid}`)) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
}

export async function probeDirectPrinter(
  value: unknown,
  {
    profile = 'moonraker',
    fetcher = nativeFetch,
    page = globalThis.location?.href || 'http://localhost/',
    signal,
  }: DirectOptions = {},
): Promise<DirectIdentity> {
  const unsupported = directBrowserError();
  if (unsupported) throw new Error(unsupported);
  if (!Object.hasOwn(DIRECT_PROFILES, profile))
    throw new TypeError('This direct printer profile is not approved.');
  const origin = directOrigin(value, page);
  const get = async (path: string): Promise<Record<string, unknown> | null> => {
    let response;
    try {
      response = await fetcher(new URL(path, origin).href, {
        method: 'GET',
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
        signal: signal || AbortSignal.timeout(6000),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new Error(
        'Cannot reach the printer/controller. Check HTTPS, CORS and trusted local access, and allow browser local-network permission.',
      );
    }
    if ([401, 403].includes(response.status))
      throw new Error(
        'The printer/controller requires authorized local access. Direct mode does not store access keys.',
      );
    if (!response.ok || !response.headers.get('Content-Type')?.includes('application/json')) {
      throw new Error(
        'This address is not a supported Klipper/Moonraker printer. Bambu LAN cameras require the Docker backend.',
      );
    }
    if (Number(response.headers.get('Content-Length')) > 1024 * 1024)
      throw new Error('The printer/controller returned an invalid identity response.');
    let payload;
    try {
      const body = await response.text();
      if (body.length > 1024 * 1024) throw new Error('Oversized identity response');
      payload = parseJson(body);
    } catch (_) {
      throw new Error('The printer/controller returned an invalid identity response.');
    }
    return isRecord(payload) && isRecord(payload.result) ? payload.result : null;
  };
  const server = await get('/server/info');
  if (
    !server ||
    !text(server.moonraker_version) ||
    !Array.isArray(server.api_version) ||
    server.api_version.length !== 3 ||
    !server.api_version.every(Number.isInteger) ||
    !Array.isArray(server.components) ||
    !server.components.includes('klippy_apis')
  ) {
    throw new Error('This address is not an identified Moonraker printer/controller.');
  }
  if (server.klippy_connected !== true)
    throw new Error('Moonraker is reachable, but its Klipper printer is disconnected.');
  const [printer, configured] = await Promise.all([get('/printer/info'), get('/server/webcams/list')]);
  if (
    !printer ||
    !states.has(typeof printer.state === 'string' ? printer.state : '') ||
    !text(printer.software_version) ||
    !text(printer.hostname)
  ) {
    throw new Error('The controller did not identify a connected Klipper printer.');
  }
  const seen = new Set();
  const cameras: CameraInfo[] = [];
  for (const camera of Array.isArray(configured?.webcams) ? configured.webcams.slice(0, 64) : []) {
    if (
      !isRecord(camera) ||
      camera.enabled !== true ||
      camera.service !== DIRECT_PROFILES[profile].service ||
      !text(camera.uid) ||
      seen.has(camera.uid)
    )
      continue;
    const stream = cameraURL(camera.stream_url, origin);
    if (!stream) continue;
    seen.add(camera.uid);
    cameras.push({
      id: cameraID(origin, camera.uid),
      name: text(camera.name) ? camera.name : printer.hostname,
      model_name: 'Klipper',
      host: new URL(origin).hostname,
      port: Number(new URL(origin).port) || (origin.startsWith('https:') ? 443 : 80),
      configured: true,
      discovered: false,
      setup: { type: 'direct' },
      direct: true,
      provider: 'moonraker',
      stream_url: stream,
      uid: camera.uid,
      firmware: printer.software_version,
    });
  }
  if (!cameras.length)
    throw new Error(
      'No enabled, same-origin MJPEG webcam is configured in Moonraker. WebRTC and external camera URLs are not supported by this direct profile.',
    );
  return {
    profile,
    origin,
    cameras,
    firmware: printer.software_version,
    hostname: printer.hostname,
    moonraker_version: server.moonraker_version,
  };
}

export class DirectPrinterBackend implements Backend {
  readonly id = 'direct';
  readonly label = 'Direct printer';
  readonly capabilities = DIRECT_CAPABILITIES;
  readonly origin: string;
  private readonly options: DirectOptions;
  private identity: DirectIdentity | null;
  private error: string | null;
  private promise: Promise<DirectIdentity> | null = null;
  constructor(origin: string, options: DirectOptions = {}) {
    this.id = 'direct';
    this.label = 'Direct printer';
    this.capabilities = DIRECT_CAPABILITIES;
    this.origin = directOrigin(origin, options.page);
    this.options = options;
    this.identity = null;
    this.error = null;
  }

  resolve(path: string) {
    const url = new URL(path, this.origin);
    if (url.origin !== this.origin || url.username || url.password)
      throw new TypeError('Unexpected direct printer origin.');
    return url.href;
  }

  ready() {
    if (!this.promise) {
      const pending = probeDirectPrinter(this.origin, this.options)
        .then((identity) => {
          if (this.promise === pending) {
            this.identity = identity;
            this.error = null;
          }
          return identity;
        })
        .catch((error) => {
          if (this.promise === pending) this.error = errorMessage(error);
          throw error;
        });
      this.promise = pending;
    }
    return this.promise;
  }

  async refresh() {
    this.promise = null;
    this.identity = null;
    return this.ready();
  }

  catalog(): CameraCatalog {
    const cameras = this.identity?.cameras || [];
    return {
      default_camera_id: cameras[0]?.id || null,
      cameras,
      discovery: { state: 'done', networks: [], cameras: [], checked: 0, total: 0 },
    };
  }

  status(camera: string | null): StreamStatus {
    const selected = this.identity?.cameras.find((item) => item.id === camera) || this.identity?.cameras[0];
    if (!selected)
      return {
        camera_id: null,
        state: 'unsupported',
        message: this.error || 'Connect an approved direct printer/controller.',
      };
    return {
      camera_id: selected.id,
      state: 'live',
      generation: `direct-${selected.id}`,
      mjpeg_url: selected.stream_url,
      live_only: true,
      message: 'Direct live camera. Recording and rewind require the Docker backend.',
      printer: {
        state: 'unsupported',
        model: 'Klipper',
        firmware: this.identity?.firmware,
        message: 'Direct camera mode does not subscribe to printer telemetry.',
      },
    };
  }

  snapshot(path: string): BackendSnapshot {
    const query = new URL(path, 'https://direct.invalid').searchParams;
    return {
      version: 1,
      catalog: this.catalog(),
      status: this.status(query.get('camera')),
      session_id: null,
      replay: null,
    };
  }

  async fetch(path: string, init: RequestInit = {}) {
    if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const url = new URL(path, 'https://direct.invalid');
    if (
      (init.method || 'GET') !== 'GET' ||
      !['/api/cameras', '/api/status', '/api/snapshot'].includes(url.pathname)
    ) {
      return json(
        {
          error:
            'Direct printer mode is live only. Recording, rewind, scanning and printer commands are unavailable.',
        },
        501,
      );
    }
    try {
      await this.ready();
    } catch (_) {
      /* Return an honest unsupported state, without polling an unrecognized device. */
    }
    return json(
      url.pathname === '/api/cameras'
        ? this.catalog()
        : url.pathname === '/api/status'
          ? this.status(url.searchParams.get('camera'))
          : this.snapshot(path),
    );
  }

  events(path: string): BackendEvents {
    const listeners = new Map<string, Set<BackendListener>>();
    let closed = false;
    const emit = (kind: string) => {
      if (closed) return;
      const event = kind === 'state' ? { data: JSON.stringify(this.snapshot(path)) } : {};
      for (const listener of listeners.get(kind) || []) listener(event);
    };
    const initial = setTimeout(async () => {
      try {
        await this.ready();
      } catch (_) {}
      emit('state');
    }, 0);
    const heartbeat = setInterval(() => emit('heartbeat'), 15000);
    return {
      readyState: 1,
      addEventListener(name: string, listener: BackendListener) {
        if (!listeners.has(name)) listeners.set(name, new Set());
        listeners.get(name)!.add(listener);
      },
      close() {
        closed = true;
        cancelTimeout(initial);
        cancelInterval(heartbeat);
        listeners.clear();
      },
    };
  }
}
