import { nativeFetch } from '../../backend-contracts/src/index.js';
import type { FileOptions } from '../../local-backend/src/file.js';
import type {
  CameraCatalog,
  StreamStatus,
  TelemetryWindow,
  PrinterTelemetry,
} from '../../backend-contracts/src/index.js';
import { LocalFileBackend } from '../../local-backend/src/file.js';

// This adapter runs entirely in the browser. It never probes a LAN, connects to
// MQTT, or treats a user video as an approved network printer.
const CAMERA = 'de00000000000001';
export const DEMO_CAPABILITIES = Object.freeze({
  discovery: false,
  configuration: false,
  telemetry: true,
  serverDvr: false,
  previewFallback: false,
  casting: false,
  localMedia: true,
});

interface DemoOptions extends FileOptions {
  prebufferSeconds?: number;
  fetcher?: typeof fetch;
}
export class DemoBackend extends LocalFileBackend {
  private readonly fetcher: typeof fetch;
  private mediaLoading: Promise<string> | null = null;
  private mediaController: AbortController | null = null;
  private demoURL: string | null = null;
  constructor({
    clock = () => Date.now() / 1000,
    duration = 300,
    prebufferSeconds = Math.min(180, duration * 0.6),
    fetcher = nativeFetch,
    media = new URL('./demo/printer.mp4', import.meta.url).href,
  }: DemoOptions = {}) {
    super({ clock, duration, media, camera: CAMERA });
    this.id = 'demo';
    this.label = 'Browser demo';
    this.capabilities = DEMO_CAPABILITIES;
    this.fetcher = fetcher;
    this.local = false;
    this.started = clock() - Math.max(0, Math.min(duration, prebufferSeconds));
  }

  override async prepareMedia() {
    if (this.local) return this.media;
    if (!this.mediaLoading) {
      // Some static hosts return the entire MP4 even for a Range request. A
      // page-owned Blob makes this small bundled clip seekable in the native
      // decoder on those hosts too, with one download shared by refreshes.
      const controller = (this.mediaController = new AbortController());
      this.mediaLoading = (async () => {
        const timeout = setTimeout(() => controller.abort(), 15000);
        try {
          const response = await this.fetcher(this.media!, { cache: 'no-store', signal: controller.signal });
          if (!response.ok || !response.headers.get('Content-Type')?.startsWith('video/mp4'))
            throw new Error('Demo video unavailable');
          const blob = await response.blob();
          controller.signal.throwIfAborted();
          if (!blob.size) throw new Error('Demo video unavailable');
          return (this.demoURL = URL.createObjectURL(blob));
        } finally {
          clearTimeout(timeout);
          if (this.mediaController === controller) this.mediaController = null;
        }
      })();
    }
    const loading = this.mediaLoading;
    try {
      return await loading;
    } catch (error) {
      if (this.mediaLoading === loading) this.mediaLoading = null;
      throw error;
    }
  }

  override setLocalMedia(file: Blob) {
    this.mediaController?.abort();
    this.mediaController = null;
    this.mediaLoading = null;
    if (this.demoURL) URL.revokeObjectURL(this.demoURL);
    this.demoURL = null;
    super.setLocalMedia(file);
  }

  override printer(at = this.clock()): PrinterTelemetry {
    if (this.local)
      return { state: 'unsupported', demo: true, message: 'Local video has no printer telemetry.' };
    const elapsed = Math.max(0, Math.min(this.duration, at - this.started));
    const printState =
      elapsed < 2
        ? 'IDLE'
        : elapsed < 30
          ? 'RUNNING'
          : elapsed < 35
            ? 'PAUSE'
            : elapsed < this.duration
              ? 'RUNNING'
              : 'FINISH';
    return {
      state: 'demo',
      connected: true,
      name: 'Generated printer demo',
      model: 'Demo printer',
      serial: 'DEMO-001',
      connection: 'connected',
      print_state: printState,
      job: 'Generated demonstration',
      progress: Math.floor((elapsed / this.duration) * 100),
      elapsed_seconds: Math.floor(elapsed),
      remaining_minutes: Math.ceil((this.duration - elapsed) / 60),
      layer: Math.floor(elapsed / 5),
      total_layers: Math.floor(this.duration / 5),
      nozzle: 210,
      nozzle_target: 210,
      bed: 60,
      bed_target: 60,
      updated_at: at,
      demo: true,
    };
  }

  override catalog(): CameraCatalog {
    return {
      default_camera_id: CAMERA,
      cameras: [
        {
          id: CAMERA,
          name: 'Generated printer demo',
          model_name: this.local ? 'Local video' : 'Demo printer',
          serial: this.local ? '' : 'DEMO-001',
          configured: true,
          discovered: false,
          setup: { type: 'none' },
          demo: true,
        },
      ],
      discovery: { state: 'done', networks: [], cameras: [], checked: 0, total: 0 },
    };
  }

  override status(): StreamStatus {
    return {
      camera_id: CAMERA,
      state: 'live',
      generation: `browser-demo-${this.generation}`,
      message: 'Generated demo video and simulated printer readings. No printer is connected.',
      media_url: this.media,
      printer: this.printer(),
      demo: true,
    };
  }

  override history(token: string, at = this.clock(), { fromStart = false } = {}): TelemetryWindow | null {
    if (this.local) return null;
    const session = this.session(token);
    if (!session) return null;
    const end = this.started + this.elapsed();
    const from = fromStart ? this.started : Math.max(this.started, Math.floor(at / 120) * 120);
    const until = fromStart ? end : Math.min(end, from + 120);
    if (until < from) return null;
    const samples = [{ at: from, printer: this.printer(from) }];
    // Sample on clip seconds so transitions retain their exact video position
    // even when the page clock and two-minute cache windows are fractional.
    for (let second = Math.floor(from - this.started) + 1; second <= until - this.started; second++) {
      const time = this.started + second;
      samples.push({ at: time, printer: this.printer(time) });
    }
    if (samples.at(-1)!.at < until) samples.push({ at: until, printer: this.printer(until) });
    return { session_id: token, camera_id: CAMERA, from, until, samples };
  }
}
