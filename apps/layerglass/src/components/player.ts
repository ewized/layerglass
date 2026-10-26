import { cancelTimeout } from '../../../backend-contracts/src/index.js';
import { eventElement } from '../dom.js';
import { PlayerElement } from './base.js';
import { playerTemplate } from './templates.js';

export class PrinterPlayer extends PlayerElement {
  declare player: PrinterPlayer;
  declare panel: HTMLElementTagNameMap['printer-settings'];
  declare settings: HTMLElementTagNameMap['printer-settings'];
  declare optionsButton: HTMLButtonElement;
  declare timer: ReturnType<typeof setTimeout> | null;
  declare interacting: boolean;
  declare surfaceWasHidden: boolean | null;
  declare isPlaying: () => boolean;
  declare togglePause: (() => void) | undefined;

  static override template = playerTemplate;

  override connectedCallback() {
    super.connectedCallback();
    this.player = this;
    this.isPlaying ??= () => false;
    this.panel = this.required<HTMLElementTagNameMap['printer-settings']>('#player-options');
    this.optionsButton = this.required<HTMLButtonElement>('#options-button');
    this.settings = this.panel;
    this.timer = null;
    this.interacting = false;
    this.surfaceWasHidden = null;
    this.listen(this, 'settings-toggle', () => this.options(Boolean(this.panel.hidden)));
    this.listen(this, 'scrub-preview-end', () => this.show());
    this.listen(this, 'pointermove', (event) => {
      if (event.pointerType !== 'touch') this.show();
    });
    this.listen(this, 'pointerdown', (event) => {
      if (eventElement(event).matches('video, #jpeg, #viewer'))
        this.surfaceWasHidden = this.classList.contains('controls-hidden');
      if (eventElement(event).closest('button, input, select, #player-options')) {
        this.interacting = true;
        this.show();
      }
    });
    this.listen(this.ownerDocument.defaultView!, 'pointerup', () => {
      if (this.interacting) {
        this.interacting = false;
        this.show();
      }
    });
    this.listen(this.ownerDocument.defaultView!, 'pointercancel', () => {
      this.interacting = false;
      this.surfaceWasHidden = null;
      this.show();
    });
    this.listen(this, 'focusin', () => this.show());
    this.listen(this, 'focusout', () => this.show());
    this.listen(this, 'click', (event) => {
      if (eventElement(event).matches('video, #jpeg, #viewer')) {
        const wasHidden = this.surfaceWasHidden ?? this.classList.contains('controls-hidden');
        this.surfaceWasHidden = null;
        if (!this.panel.hidden) this.options(false);
        else if (wasHidden) this.show();
        else if (this.canHide()) this.hide();
      } else if (eventElement(event).closest('button, input, select')) this.show();
    });
    this.listen(this, 'keydown', (event) => {
      if (event.key === 'Escape' && !this.panel.hidden) {
        this.options(false);
        event.preventDefault();
      }
      if (eventElement(event).closest('button, input, select, textarea')) return;
      if (
        (event.key === ' ' || event.key.toLowerCase() === 'k') &&
        this.panel.hidden &&
        !eventElement(event).closest('#video-context-menu, #player-stats')
      ) {
        event.preventDefault();
        this.togglePause?.();
        this.show();
      }
    });
    this.show();
  }

  canHide() {
    return (
      this.isPlaying() &&
      this.panel.hidden &&
      !this.interacting &&
      this.required<HTMLElementTagNameMap['printer-context-menu']>('#video-context-menu')?.hidden !== false &&
      this.required<HTMLElementTagNameMap['printer-scrub-preview']>('#scrub-preview')?.hidden !== false &&
      !this.querySelector('#timeline-events [role="menu"]') &&
      !this.ownerDocument.activeElement?.matches(':focus-visible') &&
      !this.ownerDocument.hidden
    );
  }

  show() {
    this.player.classList.remove('controls-hidden');
    cancelTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (this.canHide()) this.hide();
    }, 3000);
  }

  hide() {
    this.required<HTMLElementTagNameMap['printer-scrub-preview']>('#scrub-preview')?.hide();
    this.player.classList.add('controls-hidden');
  }

  options(open: boolean, page: 'root' | 'printers' | 'backends' = 'root') {
    this.required<HTMLElementTagNameMap['printer-scrub-preview']>('#scrub-preview')?.hide();
    const hadFocus = this.panel.contains(this.ownerDocument.activeElement);
    this.panel.hidden = !open;
    this.settings.navigate(open ? page : 'root', false, open && page === 'root');
    this.optionsButton.setAttribute('aria-expanded', String(open));
    if (!open && hadFocus) this.optionsButton.focus({ preventScroll: true });
    if (open)
      this.required<HTMLElementTagNameMap['printer-context-menu']>('#video-context-menu').hidden = true;
    this.show();
  }

  configure({ isPlaying, togglePause }: { isPlaying: () => boolean; togglePause: () => void }) {
    this.isPlaying = isPlaying;
    this.togglePause = togglePause;
  }

  override disconnectedCallback() {
    cancelTimeout(this.timer);
    super.disconnectedCallback();
  }
}
