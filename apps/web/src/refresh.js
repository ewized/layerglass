import { reloadKey, legacyReloadKey } from './preferences.js';

export class PlayerReload {
  static key = reloadKey;

  static remember(cameraId) {
    try {
      history.replaceState({ ...history.state, [this.key]: {
        version: 1, reason: 'pull-to-refresh', autoplay: true,
        cameraId: cameraId || null, requestedAt: Date.now(),
      } }, '');
      return true;
    } catch (_) { return false; /* A plain reload can still autoplay muted. */ }
  }

  static consume() {
    const state = history.state;
    if (!state || (!Object.hasOwn(state, this.key) && !Object.hasOwn(state, legacyReloadKey))) return null;
    const intent = Object.hasOwn(state, this.key) ? state[this.key] : state[legacyReloadKey];
    try {
      const next = { ...state };
      delete next[this.key];
      delete next[legacyReloadKey];
      history.replaceState(next, '');
    } catch (_) { return null; /* Do not reuse an intent we cannot clear. */ }
    const age = Date.now() - intent?.requestedAt;
    if (performance.getEntriesByType('navigation')[0]?.type !== 'reload' ||
        intent?.version !== 1 || intent.reason !== 'pull-to-refresh' || intent.autoplay !== true ||
        !Number.isFinite(intent.requestedAt) || age < 0 || age > 120000 ||
        !(intent.cameraId === null || (typeof intent.cameraId === 'string' && intent.cameraId.length > 0 && intent.cameraId.length <= 128))) return null;
    return intent;
  }

  static reload(cameraId) {
    this.remember(cameraId);
    window.location.reload();
  }
}

export class PlayerPullRefresh {
  constructor(player, reload) {
    this.indicator = document.getElementById('pull-refresh');
    this.label = document.getElementById('pull-refresh-label');
    this.panel = document.getElementById('player-options');
    this.reload = reload;
    this.threshold = 90;
    this.refreshing = false;
    this.suppressClickUntil = 0;
    this.reset();
    player.addEventListener('touchstart', event => this.start(event), { passive: true });
    player.addEventListener('touchmove', event => this.move(event), { passive: false });
    player.addEventListener('touchend', event => this.end(event), { passive: false });
    player.addEventListener('touchcancel', () => this.reset(), { passive: true });
    // A completed pull must not become a tap that hides controls or retries fullscreen.
    player.addEventListener('click', event => {
      if (performance.now() < this.suppressClickUntil && event.target.closest('#viewer')) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }, true);
    window.addEventListener('blur', () => this.reset());
    window.addEventListener('orientationchange', () => this.reset());
  }

  reset() {
    this.origin = null;
    this.pulling = false;
    this.distance = 0;
    if (!this.refreshing) this.indicator.hidden = true;
  }

  start(event) {
    this.reset();
    if (this.refreshing || event.touches.length !== 1 || !this.panel.hidden || window.scrollY > 0 ||
        !event.target.closest('#viewer') || event.target.closest('button, a, input, select, textarea')) return;
    const touch = event.touches[0];
    this.origin = { x: touch.clientX, y: touch.clientY, id: touch.identifier };
  }

  move(event) {
    if (!this.origin) return;
    const touch = event.touches[0];
    if (event.touches.length !== 1 || touch.identifier !== this.origin.id || !event.cancelable) { this.reset(); return; }
    const dx = Math.abs(touch.clientX - this.origin.x);
    const dy = touch.clientY - this.origin.y;
    if (!this.pulling) {
      if (Math.max(dx, Math.abs(dy)) < 10) return;
      if (dy <= 0 || dy < dx * 1.25) { this.reset(); return; }
      this.pulling = true;
    }
    event.preventDefault();
    this.distance = Math.max(0, dy);
    const ready = this.distance >= this.threshold;
    this.indicator.hidden = false;
    this.indicator.classList.toggle('ready', ready);
    this.indicator.style.setProperty('--pull-offset', `${Math.min(this.distance * 0.45, 60)}px`);
    this.indicator.style.setProperty('--pull-turn', `${Math.min(this.distance / this.threshold, 1) * 180}deg`);
    const label = ready ? 'Release to reload' : 'Pull to reload';
    if (this.label.textContent !== label) this.label.textContent = label;
  }

  end(event) {
    if (!this.origin) return;
    const ready = this.pulling && this.distance >= this.threshold && event.touches.length === 0;
    if (this.pulling) {
      event.preventDefault();
      this.suppressClickUntil = performance.now() + 500;
    }
    this.reset();
    if (!ready || this.refreshing) return;
    this.refreshing = true;
    this.indicator.hidden = false;
    this.indicator.classList.add('loading');
    this.label.textContent = 'Reloading…';
    this.reload();
  }
}
