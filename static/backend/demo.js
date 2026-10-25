// This adapter runs entirely in the browser. It never probes a LAN, connects to
// MQTT, or treats a user video as an approved network printer.
const CAMERA = 'de00000000000001';
export const DEMO_CAPABILITIES = Object.freeze({ discovery: false, configuration: false,
  telemetry: true, serverDvr: false, previewFallback: false, casting: false, localMedia: true });
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
});

export class DemoBackend {
  constructor({ clock = () => Date.now() / 1000, duration = 300,
    media = new URL('../demo/printer.mp4', import.meta.url).href } = {}) {
    this.id = 'demo'; this.label = 'Browser demo'; this.capabilities = DEMO_CAPABILITIES;
    this.clock = clock; this.duration = duration; this.media = media;
    this.started = clock(); this.sessions = new Map(); this.generation = 0;
  }

  resolve(path) { return path; }
  elapsed() { return Math.max(0, Math.min(this.duration, this.clock() - this.started)); }

  setLocalMedia(file) {
    if (this.localURL) URL.revokeObjectURL(this.localURL);
    this.media = this.localURL = URL.createObjectURL(file);
    this.duration = Infinity;
    this.started = this.clock();
    this.generation++;
    this.local = true;
    this.capabilities = Object.freeze({ ...DEMO_CAPABILITIES, telemetry: false });
  }

  setDuration(duration) { if (Number.isFinite(duration) && duration > 0) this.duration = duration; }

  printer(at = this.clock()) {
    if (this.local) return { state: 'unsupported', demo: true, message: 'Local video has no printer telemetry.' };
    const elapsed = Math.max(0, Math.min(this.duration, at - this.started));
    const printState = elapsed < 2 ? 'IDLE' : elapsed < 30 ? 'RUNNING' : elapsed < 35 ? 'PAUSE' : elapsed < this.duration ? 'RUNNING' : 'FINISH';
    return { state: 'demo', connected: true, name: 'Generated printer demo', model: 'Demo printer',
      serial: 'DEMO-001', connection: 'connected', print_state: printState,
      job: 'Generated demonstration', progress: Math.floor(elapsed / this.duration * 100),
      elapsed_seconds: Math.floor(elapsed), remaining_minutes: Math.ceil((this.duration - elapsed) / 60),
      layer: Math.floor(elapsed / 5), total_layers: Math.floor(this.duration / 5),
      nozzle: 210, nozzle_target: 210, bed: 60, bed_target: 60, updated_at: at,
      demo: true };
  }

  catalog() {
    return { default_camera_id: CAMERA, cameras: [{ id: CAMERA, name: 'Generated printer demo',
      model_name: this.local ? 'Local video' : 'Demo printer', serial: this.local ? '' : 'DEMO-001', configured: true, discovered: false,
      setup: { type: 'none' }, demo: true }],
    discovery: { state: 'done', networks: [], cameras: [], checked: 0, total: 0 } };
  }

  status() {
    return { camera_id: CAMERA, state: 'live', generation: `browser-demo-${this.generation}`,
      message: 'Generated demo video and simulated printer readings. No printer is connected.',
      media_url: this.media, printer: this.printer(), demo: true };
  }

  session(token) {
    if (!this.sessions.has(token)) return null;
    return { session_id: token, camera_id: CAMERA, kind: 'file', ready: true,
      media_url: this.media, start_seconds: 0, end_seconds: this.elapsed(),
      clock: [{ position: 0, time: this.started }], error: null, limited: false,
      preview_fallback: false, telemetry: this.capabilities.telemetry, demo: true };
  }

  history(token, at = this.clock()) {
    if (this.local) return null;
    const session = this.session(token);
    if (!session) return null;
    const end = this.started + this.elapsed();
    const from = Math.max(this.started, Math.floor(at / 120) * 120);
    const until = Math.min(end, from + 120);
    if (until < from) return null;
    const samples = [];
    for (let time = from; time <= until; time += 1) samples.push({ at: time, printer: this.printer(time) });
    return { session_id: token, camera_id: CAMERA, from, until, samples };
  }

  snapshot(path) {
    const query = new URL(path, 'http://demo.invalid').searchParams;
    const token = query.get('session');
    return { version: 1, catalog: this.catalog(), status: this.status(), session_id: token,
      replay: this.session(token), ...(this.session(token) ? { telemetry: this.history(token) } : {}) };
  }

  async fetch(path, init = {}) {
    if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const url = new URL(path, 'http://demo.invalid');
    const method = init.method || 'GET';
    if (method === 'GET' && url.pathname === '/api/cameras') return json(this.catalog());
    if (method === 'GET' && url.pathname === '/api/status') return json(this.status());
    if (method === 'GET' && url.pathname === '/api/snapshot') return json(this.snapshot(path));
    if (method === 'POST' && url.pathname === '/api/sessions') {
      const camera = JSON.parse(init.body || '{}').camera_id;
      if (camera !== CAMERA) return json({ error: 'The demo has no network printers.' }, 404);
      const token = crypto.randomUUID().replaceAll('-', '');
      this.sessions.set(token, true);
      return json(this.session(token));
    }
    const match = /^\/api\/sessions\/([a-f0-9]{32})(?:\/(printer|close))?$/.exec(url.pathname);
    if (match) {
      if (method === 'POST' && match[2] === 'close') { this.sessions.delete(match[1]); return json({ ok: true }); }
      const body = match[2] === 'printer' ? this.history(match[1], Number(url.searchParams.get('at'))) : this.session(match[1]);
      return json(body || { error: 'Demo session expired.' }, body ? 200 : 404);
    }
    return json({ error: 'This feature requires the optional Python backend.' }, 501);
  }

  events(path) {
    const listeners = new Map();
    const emit = () => {
      const event = { data: JSON.stringify(this.snapshot(path)) };
      for (const listener of listeners.get('state') || []) listener(event);
    };
    const initial = setTimeout(emit, 0);
    const timer = setInterval(emit, 1000);
    return { readyState: 1, addEventListener(name, listener) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(listener);
    }, close() { clearTimeout(initial); clearInterval(timer); listeners.clear(); } };
  }
}
