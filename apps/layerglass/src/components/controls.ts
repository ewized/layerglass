import { PlayerElement } from './base.js';
import { controlsTemplate } from './templates.js';

export class PrinterControls extends PlayerElement {
  static override template = controlsTemplate;

  override connectedCallback() {
    super.connectedCallback();
    this.listen(this.required<HTMLButtonElement>('#options-button'), 'click', () =>
      this.emit('settings-toggle'),
    );
    this.listen(this.required<HTMLButtonElement>('#cast-button'), 'click', () => this.emit('cast-request'));
    this.listen(this.required<HTMLButtonElement>('#fullscreen-button'), 'click', () =>
      this.emit('fullscreen-toggle'),
    );
  }
}
