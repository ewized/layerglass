import { PlayerElement } from './base.js';
import { controlsTemplate } from './templates.js';

export class PrinterControls extends PlayerElement {
  static template = controlsTemplate;

  connectedCallback() {
    super.connectedCallback();
    this.listen(this.querySelector('#options-button'), 'click', () => this.emit('settings-toggle'));
    this.listen(this.querySelector('#cast-button'), 'click', () => this.emit('cast-request'));
    this.listen(this.querySelector('#fullscreen-button'), 'click', () => this.emit('fullscreen-toggle'));
  }
}
