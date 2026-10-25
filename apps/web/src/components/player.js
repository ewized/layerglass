import { PlayerElement } from './base.js';
import { playerTemplate } from './templates.js';

export class PrinterPlayer extends PlayerElement {
  static template = playerTemplate;

  connectedCallback() {
    super.connectedCallback();
    const player = this;
    this.player = this;
    this.isPlaying ??= () => false;
    this.panel = this.querySelector('#player-options');
    this.optionsButton = this.querySelector('#options-button');
    this.settings = this.panel;
    this.timer = null;
    this.interacting = false;
    this.surfaceWasHidden = null;
    this.listen(this, 'settings-toggle', () => this.options(this.panel.hidden));
    this.listen(this, 'scrub-preview-end', () => this.show());
    this.listen(player, 'pointermove', event => { if (event.pointerType !== 'touch') this.show(); });
    this.listen(player, 'pointerdown', event => {
      if (event.target.matches('video, #jpeg, #viewer')) this.surfaceWasHidden = player.classList.contains('controls-hidden');
      if (event.target.closest('button, input, select, #player-options')) { this.interacting = true; this.show(); }
    });
    this.listen(this.ownerDocument.defaultView, 'pointerup', () => { if (this.interacting) { this.interacting = false; this.show(); } });
    this.listen(this.ownerDocument.defaultView, 'pointercancel', () => { this.interacting = false; this.surfaceWasHidden = null; this.show(); });
    this.listen(player, 'focusin', () => this.show());
    this.listen(player, 'focusout', () => this.show());
    this.listen(player, 'click', event => {
      if (event.target.matches('video, #jpeg, #viewer')) {
        const wasHidden = this.surfaceWasHidden ?? player.classList.contains('controls-hidden');
        this.surfaceWasHidden = null;
        if (!this.panel.hidden) this.options(false);
        else if (wasHidden) this.show();
        else if (this.canHide()) this.hide();
      } else if (event.target.closest('button, input, select')) this.show();
    });
    this.listen(player, 'keydown', event => {
      if (event.key === 'Escape' && !this.panel.hidden) { this.options(false); event.preventDefault(); }
      if (event.target.closest('button, input, select, textarea')) return;
      if ((event.key === ' ' || event.key.toLowerCase() === 'k') && this.panel.hidden &&
          !event.target.closest('#video-context-menu, #player-stats')) {
        event.preventDefault();
        this.togglePause?.();
        this.show();
      }
    });
    this.show();
  }

  canHide() {
    return this.isPlaying() && this.panel.hidden && !this.interacting &&
      this.querySelector('#video-context-menu')?.hidden !== false &&
      this.querySelector('#scrub-preview')?.hidden !== false &&
      !this.ownerDocument.activeElement?.matches(':focus-visible') && !this.ownerDocument.hidden;
  }

  show() {
    this.player.classList.remove('controls-hidden');
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { if (this.canHide()) this.hide(); }, 3000);
  }

  hide() {
    this.querySelector('#scrub-preview')?.hide();
    this.player.classList.add('controls-hidden');
  }

  options(open, page = 'root') {
    this.querySelector('#scrub-preview')?.hide();
    const hadFocus = this.panel.contains(this.ownerDocument.activeElement);
    this.panel.hidden = !open;
    this.settings.navigate(open ? page : 'root', false, open && page === 'root');
    this.optionsButton.setAttribute('aria-expanded', String(open));
    if (!open && hadFocus) this.optionsButton.focus({ preventScroll: true });
    if (open) this.querySelector('#video-context-menu').hidden = true;
    this.show();
  }

  configure({ isPlaying, togglePause }) {
    this.isPlaying = isPlaying;
    this.togglePause = togglePause;
  }

  disconnectedCallback() {
    clearTimeout(this.timer);
    super.disconnectedCallback();
  }
}
