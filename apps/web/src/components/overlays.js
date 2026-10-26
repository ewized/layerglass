import { PlayerElement } from './base.js';
import { cameraTemplate, loadingTemplate, pullTemplate, contextTemplate } from './templates.js';
import { DIFFUSION_SAMPLE_INTERVAL, diffusionSampleSize, diffusionPalette, diffusionGradient } from '../diffusion.js';

export class PrinterLoading extends PlayerElement {
  static template = loadingTemplate;

  connectedCallback() {
    super.connectedCallback();
    this.listen(this.querySelector('#play-button'), 'click', () => this.emit('player-play'));
    this.listen(this.querySelector('#empty-scan-button'), 'click', () => this.emit('printer-scan-open'));
  }

  show(title, detail, spinning = true) {
    this.hidden = false;
    this.querySelector('#overlay-title').textContent = title;
    this.querySelector('#overlay-subtitle').textContent = detail;
    this.querySelector('#loader').hidden = !spinning;
    this.querySelector('#offline-icon').toggleAttribute('hidden', title !== 'Offline');
    this.querySelector('#play-button').hidden = true;
  }
}

export class PrinterCameraView extends PlayerElement {
  static template = cameraTemplate;

  connectedCallback() {
    super.connectedCallback();
    this.video = this.querySelector('video');
    this.image = this.querySelector('img');
    this.diffusion = this.querySelector('#video-diffusion');
    this.diffusionBase = this.diffusion.querySelector('.diffusion-base');
    this.diffusionNext = this.diffusion.querySelector('.diffusion-next');
    const view = this.ownerDocument.defaultView;
    this.reducedMotion = view.matchMedia('(prefers-reduced-motion: reduce)');
    this.listen(this.video, 'timeupdate', () => this.drawDiffusion());
    for (const event of ['loadeddata', 'seeked']) this.listen(this.video, event, () => this.drawDiffusion(true));
    this.listen(this.video, 'emptied', () => this.clearDiffusion());
    this.listen(this.image, 'load', () => this.drawDiffusion());
    this.listen(this.diffusionNext, 'transitionend', event => {
      if (event.propertyName === 'opacity') this.finishDiffusion();
    });
    this.listen(this.reducedMotion, 'change', () => {
      this.finishDiffusion(true);
      this.drawDiffusion(true);
    });
    this.listen(this.ownerDocument, 'visibilitychange', () => {
      if (this.ownerDocument.hidden) this.finishDiffusion(true);
      else this.drawDiffusion(true);
    });
    this.resizeObserver = new view.ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect;
      this.viewWidth = width;
      this.viewHeight = height;
      this.drawDiffusion(true);
    });
    this.resizeObserver.observe(this);
  }

  disconnectedCallback() {
    this.resizeObserver?.disconnect();
    this.clearDiffusion();
    super.disconnectedCallback();
  }

  clearDiffusion() {
    this.ownerDocument.defaultView.clearTimeout(this.diffusionTimer);
    this.diffusion.hidden = true;
    this.diffusion.classList.remove('blending');
    this.diffusionBase.style.background = '';
    this.diffusionNext.style.background = '';
    this.diffusionSource = null;
    this.diffusionBackground = this.diffusionTarget = this.diffusionPending = null;
  }

  setDiffusionGradient(background, immediate = false) {
    if (immediate || this.diffusion.hidden || this.reducedMotion.matches) {
      this.ownerDocument.defaultView.clearTimeout(this.diffusionTimer);
      this.diffusionBase.style.background = background;
      this.diffusionBackground = background;
      this.diffusionTarget = this.diffusionPending = null;
      this.diffusion.classList.remove('blending');
      this.diffusion.hidden = false;
      return;
    }
    if (this.diffusionTarget) {
      // A seek during a fade queues only its latest colors, avoiding a jump.
      this.diffusionPending = background === this.diffusionTarget ? null : background;
      return;
    }
    if (background === this.diffusionBackground) return;
    this.diffusionTarget = background;
    this.diffusionNext.style.background = background;
    // Commit the hidden layer's reset before starting its next CSS transition.
    // This is one style read per new palette, not a per-frame animation loop.
    this.ownerDocument.defaultView.getComputedStyle(this.diffusionNext).opacity;
    this.diffusion.classList.add('blending');
    // transitionend may be skipped when a tab is suspended or styles change.
    this.diffusionTimer = this.ownerDocument.defaultView.setTimeout(() => this.finishDiffusion(), 2200);
  }

  finishDiffusion(immediate = false) {
    if (!this.diffusionTarget) return;
    const pending = this.diffusionPending;
    const background = this.diffusionTarget;
    this.setDiffusionGradient(background, true);
    if (pending) this.setDiffusionGradient(pending, immediate);
  }

  drawDiffusion(force = false) {
    if (!this.isConnected || this.ownerDocument.hidden || this.diffusionUnavailable) return;
    const source = this.image.hidden ? this.video : this.image;
    const width = source === this.video ? source.videoWidth : source.naturalWidth;
    const height = source === this.video ? source.videoHeight : source.naturalHeight;
    if (!width || !height || (source === this.video && source.readyState < 2) || !this.viewWidth || !this.viewHeight) return;
    const scale = Math.min(this.viewWidth / width, this.viewHeight / height);
    if (this.viewWidth - width * scale < 2 && this.viewHeight - height * scale < 2) {
      this.clearDiffusion();
      return;
    }
    const now = performance.now();
    if (!force && source === this.diffusionSource && !this.diffusion.hidden &&
        (this.reducedMotion.matches || now - this.lastDiffusionAt < DIFFUSION_SAMPLE_INTERVAL)) return;
    try {
      // The detached canvas only reads colors. CSS paints and crossfades the
      // visible background; native video remains the only decoder.
      this.diffusionSample ??= this.ownerDocument.createElement('canvas');
      this.diffusionContext ??= this.diffusionSample.getContext('2d', { alpha: false, willReadFrequently: true });
      if (!this.diffusionContext) { this.diffusionUnavailable = true; return; }
      const sample = diffusionSampleSize(width, height);
      if (this.diffusionSample.width !== sample.width) this.diffusionSample.width = sample.width;
      if (this.diffusionSample.height !== sample.height) this.diffusionSample.height = sample.height;
      this.diffusionContext.drawImage(source, 0, 0, sample.width, sample.height);
      this.setDiffusionGradient(diffusionGradient(diffusionPalette(
        this.diffusionContext.getImageData(0, 0, sample.width, sample.height))));
      this.lastDiffusionAt = now;
      this.diffusionSource = source;
    } catch (error) {
      if (error.name === 'InvalidStateError') return; // A source can change between metadata and drawing.
      this.clearDiffusion();
      this.diffusionUnavailable = true;
      console.debug('[LayerGlass] Video background unavailable', error.name);
    }
  }

  waiting(title, detail, spinning) {
    this.querySelector('printer-loading').show(title, detail, spinning);
    this.classList.remove('playing');
    this.clearDiffusion();
  }

  markFrame() {
    this.querySelector('printer-loading').hidden = true;
    this.querySelector('#play-button').hidden = true;
    this.classList.add('playing');
  }
}

export class PrinterPullIndicator extends PlayerElement {
  static template = pullTemplate;
}

export class PrinterContextMenu extends PlayerElement {
  static template = contextTemplate;

  connectedCallback() {
    super.connectedCallback();
    this.listen(this, 'click', event => {
      const button = event.target.closest('[data-player-action]');
      if (button) this.emit('player-action', { action: button.dataset.playerAction, keyboard: event.detail === 0 });
    });
    this.listen(this, 'keydown', event => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      const buttons = this.availableActions();
      if (!buttons.length) { event.preventDefault(); return; }
      const index = buttons.indexOf(this.ownerDocument.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 :
        (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length;
      buttons[next].focus();
      event.preventDefault();
    });
    this.listen(this.ownerDocument, 'click', event => { if (!this.contains(event.target)) this.close(); });
    this.listen(this.ownerDocument.defaultView, 'resize', () => this.close());
    this.listen(this.ownerDocument.defaultView, 'pagehide', () => this.close());
  }

  availableActions() {
    return [...this.querySelectorAll('button:not(:disabled)')].filter(button => button.getClientRects().length);
  }

  openAt(x, y, player = this.closest('printer-player')) {
    clearTimeout(this.copyTimer);
    this.openRevision = (this.openRevision || 0) + 1;
    const copy = this.querySelector('[data-player-action="copy-debug"]');
    copy.querySelector('use').setAttribute('href', '#i-copy');
    copy.querySelector('span').textContent = 'Copy debug info';
    copy.removeAttribute('aria-label');
    this.hidden = false;
    const rect = player.getBoundingClientRect();
    const size = this.getBoundingClientRect();
    this.style.left = `${Math.max(8, Math.min(x - rect.left, rect.width - size.width - 8))}px`;
    this.style.top = `${Math.max(8, Math.min(y - rect.top, rect.height - size.height - 8))}px`;
    this.availableActions()[0]?.focus({ preventScroll: true });
  }

  close(focus = false) {
    clearTimeout(this.copyTimer);
    this.openRevision = (this.openRevision || 0) + 1;
    const wasOpen = !this.hidden;
    this.hidden = true;
    if (focus && wasOpen) this.closest('printer-player')?.focus({ preventScroll: true });
  }

  copyFeedback(success) {
    const button = this.querySelector('[data-player-action="copy-debug"]');
    button.querySelector('use').setAttribute('href', success ? '#i-check' : '#i-copy');
    button.querySelector('span').textContent = success ? 'Copied' : 'Try copying again';
    button.setAttribute('aria-label', success ? 'Debug info copied' : 'Could not copy debug info. Try again');
    clearTimeout(this.copyTimer);
    if (success) this.copyTimer = setTimeout(() => this.close(true), 1000);
  }

  disconnectedCallback() {
    this.close();
    super.disconnectedCallback();
  }
}
