/** Public wire contracts. Keep server field names stable across transports. */
export type BackendConfiguration =
  { type: 'python'; url: string } | { type: 'demo' } | { type: 'direct'; profile: 'moonraker'; url: string };

export interface BackendCapabilities {
  readonly discovery: boolean;
  readonly configuration: boolean;
  readonly telemetry: boolean;
  readonly serverDvr: boolean;
  readonly previewFallback: boolean;
  readonly casting: boolean;
  readonly localMedia: boolean;
  readonly cameraSelection?: boolean;
  readonly liveOnly?: boolean;
}

export interface CameraInfo {
  id: string;
  name: string;
  model_name?: string;
  model?: string;
  manufacturer?: string;
  serial?: string;
  host?: string;
  port?: number;
  configured: boolean;
  discovered: boolean;
  setup: { type: string; [key: string]: unknown };
  direct?: boolean;
  demo?: boolean;
  provider?: string;
  stream_url?: string;
  uid?: string;
  firmware?: string;
  [key: string]: unknown;
}

export interface DiscoveryInfo {
  state: string;
  scan_id?: string;
  cached?: number;
  networks: string[];
  cameras: unknown[];
  checked: number;
  total: number;
  [key: string]: unknown;
}

export interface CameraCatalog {
  default_camera_id: string | null;
  cameras: CameraInfo[];
  discovery: DiscoveryInfo;
}

export interface PrinterTelemetry {
  state?: string;
  connected?: boolean;
  name?: string;
  model?: string;
  serial?: string;
  firmware?: string;
  connection?: string;
  message?: string;
  print_state?: string;
  job?: string;
  progress?: number;
  elapsed_seconds?: number;
  remaining_minutes?: number;
  layer?: number;
  total_layers?: number;
  nozzle?: number;
  nozzle_target?: number;
  bed?: number;
  bed_target?: number;
  updated_at?: number;
  nozzle_count?: number;
  nozzle_1?: number;
  nozzle_1_target?: number;
  nozzle_2?: number;
  nozzle_2_target?: number;
  active_nozzle?: number;
  speed_percent?: number;
  speed_mode?: string;
  chamber?: number;
  chamber_target?: number;
  part_fan?: number;
  aux_fan?: number;
  exhaust_fan?: number;
  heatbreak_fan?: number;
  wifi?: string;
  error?: number | string;
  alerts?: unknown[];
  reported?: Record<string, unknown>;
  demo?: boolean;
  [key: string]: unknown;
}

export interface StreamStatus {
  camera_id: string | null;
  state: string;
  generation?: string | number;
  message: string;
  media_url?: string | null;
  playlist_url?: string | null;
  video_url?: string | null;
  jpeg_url?: string | null;
  mjpeg_url?: string | null;
  printer?: PrinterTelemetry | null;
  live_only?: boolean;
  demo?: boolean;
  [key: string]: unknown;
}

export interface ClockPoint {
  position: number;
  time: number;
}
export interface JpegFrame {
  sequence: number;
  start: number;
  position: number;
  time: number;
  clock: ClockPoint[];
}
export interface ReplaySession {
  session_id: string;
  camera_id: string;
  kind: 'hls' | 'jpeg' | 'file';
  ready: boolean;
  start_seconds: number;
  end_seconds: number;
  clock: ClockPoint[];
  error: string | null;
  limited: boolean;
  media_url?: string | null;
  playlist_url?: string | null;
  video_url?: string | null;
  frame_url?: string | null;
  preview_url?: string | null;
  end_time?: number;
  jpeg_frame?: JpegFrame | null;
  preview_fallback?: boolean;
  telemetry?: boolean;
  demo?: boolean;
  [key: string]: unknown;
}

export interface PrinterSample {
  at: number;
  printer: PrinterTelemetry;
}
export interface TelemetryWindow {
  session_id: string;
  camera_id: string;
  from: number;
  until: number;
  samples: PrinterSample[];
}
export interface BackendSnapshot {
  version: number;
  catalog: CameraCatalog;
  status: StreamStatus;
  session_id: string | null;
  replay: ReplaySession | null;
  telemetry?: TelemetryWindow | null;
}

export interface BackendMessage {
  data?: string;
}
export type BackendListener = (event: BackendMessage) => void;
export interface BackendEvents {
  readonly readyState: number;
  onerror?: ((event: Event) => void) | null;
  addEventListener(kind: string, listener: BackendListener): void;
  dispatchEvent?(event: Event): boolean;
  close(): void;
}
export interface Backend {
  readonly id: 'python' | 'demo' | 'direct' | 'local';
  readonly label: string;
  readonly capabilities: BackendCapabilities;
  readonly origin?: string;
  resolve(path: string): string;
  fetch(path: string, init?: RequestInit): Promise<Response>;
  events(path: string): BackendEvents;
  prepareMedia?(): Promise<string | null>;
  setLocalMedia?(file: Blob): void;
  setDuration?(duration: number): void;
  refresh?(): Promise<unknown>;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function errorMessage(error: unknown): string {
  return isRecord(error) && typeof error.message === 'string' ? error.message : String(error);
}

export function errorName(error: unknown): string {
  return isRecord(error) && typeof error.name === 'string' ? error.name : 'Error';
}

export function parseJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
export function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}
export function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

export function cancelTimeout(timer: ReturnType<typeof setTimeout> | null | undefined) {
  if (timer !== null && timer !== undefined) clearTimeout(timer);
}
export function cancelInterval(timer: ReturnType<typeof setInterval> | null | undefined) {
  if (timer !== null && timer !== undefined) clearInterval(timer);
}

/** Keep the browser's Window receiver when adapters store their fetch function. */
export const nativeFetch: typeof fetch = (...args) => globalThis.fetch(...args);
