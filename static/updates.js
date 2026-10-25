import { PlayerLog } from './log.js';
import { playerVisible } from './visibility.js';

// One metadata connection per visible player. Commands remain occasional POSTs;
// video playlists and segments remain owned by the platform decoder / hls.js.
export class PlayerUpdates {
  constructor(onState, onUnavailable, backend = {}) {
    this.onState = onState;
    this.onUnavailable = onUnavailable;
    this.backend = backend;
    this.fetcher = backend.fetch?.bind(backend) || ((...args) => fetch(...args));
    this.camera = null;
    this.session = null;
    this.started = false;
    this.suspended = false;
    this.source = null;
    this.streaming = false;
    this.version = 0;
    this.fallbackTimer = null;
    this.retryTimer = null;
    this.watchdogTimer = null;
    this.controller = null;
    const visibility = () => {
      if (!playerVisible()) this.disconnect();
      else if (this.started && !this.source && !this.controller) this.connect();
    };
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('playerviewchange', visibility);
    window.addEventListener('online', () => { if (this.started) this.connect(); });
    window.addEventListener('offline', () => { if (this.backend.id !== 'demo') { this.disconnect(); this.onUnavailable(); } });
    window.addEventListener('pagehide', () => { this.suspended = true; this.disconnect(); }, true);
    window.addEventListener('pageshow', event => {
      this.suspended = false;
      if (event.persisted && this.started) this.connect();
    });
  }

  subscribe(camera, session = null) {
    // Old or damaged local preferences must still reach the initial catalog,
    // which can select an available camera. Never send malformed query IDs.
    camera = typeof camera === 'string' && /^[a-f0-9]{16}$/.test(camera) ? camera : null;
    session = typeof session === 'string' && /^[a-f0-9]{32}$/.test(session) ? session : null;
    if (this.started && this.camera === camera && this.session === session) return;
    this.camera = camera;
    this.session = session;
    this.started = true;
    this.connect();
  }

  query() {
    const query = new URLSearchParams();
    if (this.camera) query.set('camera', this.camera);
    if (this.session) query.set('session', this.session);
    const encoded = query.toString();
    return encoded ? `?${encoded}` : '';
  }

  disconnect() {
    this.version++;
    this.streaming = false;
    this.source?.close();
    this.source = null;
    for (const timer of ['fallbackTimer', 'retryTimer', 'watchdogTimer']) {
      clearTimeout(this[timer]);
      this[timer] = null;
    }
    this.controller?.abort();
    this.controller = null;
  }

  connect() {
    this.disconnect();
    if (!playerVisible() || this.suspended || this.backend.id !== 'demo' && globalThis.navigator?.onLine === false) return;
    const version = this.version;
    if (!this.backend.events && typeof window.EventSource !== 'function') { this.fallback(); return; }
    let source;
    try { source = this.backend.events ? this.backend.events(`/api/events${this.query()}`) : new EventSource(`/api/events${this.query()}`); }
    catch (_) { this.fallback(); return; }
    this.source = source;
    const current = () => this.version === version && this.source === source;
    const received = () => {
      if (!this.streaming) PlayerLog.changed('info', 'Updates', { transport: 'SSE', state: 'Connected' });
      this.streaming = true;
      clearTimeout(this.fallbackTimer);
      this.fallbackTimer = null;
      this.controller?.abort();
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = setTimeout(() => { if (current()) this.connect(); }, 45000);
    };
    source.addEventListener('state', event => {
      if (!current()) return;
      let state;
      try { state = JSON.parse(event.data); } catch (_) { return; }
      if (state?.version !== 1) return;
      received();
      this.onState(state);
    });
    source.addEventListener('heartbeat', () => { if (current()) received(); });
    source.onerror = () => {
      if (!current()) return;
      this.streaming = false;
      this.onUnavailable();
      this.scheduleFallback(10000);
      // EventSource retries interrupted connections itself. A rejected endpoint
      // can instead become CLOSED, so periodically retry that case too.
      if (source.readyState === 2 && !this.retryTimer) {
        this.retryTimer = setTimeout(() => { if (current()) this.connect(); }, 30000);
      }
    };
    this.scheduleFallback(10000);
  }

  scheduleFallback(delay) {
    if (this.fallbackTimer || !playerVisible() || this.suspended || globalThis.navigator?.onLine === false) return;
    this.fallbackTimer = setTimeout(() => { this.fallbackTimer = null; this.fallback(); }, delay);
  }

  async fallback() {
    if (this.streaming || !playerVisible() || this.suspended || this.controller || globalThis.navigator?.onLine === false) return;
    const version = this.version;
    const controller = new AbortController();
    this.controller = controller;
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await this.fetcher(`/api/snapshot${this.query()}`, { cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error('Viewer updates unavailable');
      const state = await response.json();
      if (this.version === version && !this.streaming && state?.version === 1) {
        PlayerLog.changed('info', 'Updates', { transport: 'HTTP fallback', state: 'Connected' });
        this.onState(state);
      }
    } catch (_) { if (this.version === version && !this.streaming) this.onUnavailable(); }
    finally {
      clearTimeout(timeout);
      if (this.controller === controller) this.controller = null;
      if (this.version === version && !this.streaming) this.scheduleFallback(15000);
    }
  }
}
