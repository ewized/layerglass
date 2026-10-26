import { PlayerElement } from './base.js';
import { settingsTemplate } from './templates.js';

export class PrinterSettings extends PlayerElement {
  static template = settingsTemplate;

  set busy(value) { this.querySelector('#settings-back').disabled = value; }

  set discoveryEnabled(value) {
    this.canScan = value;
    this.querySelector('#scan-button').hidden = this.page !== 'printers' || !value;
  }

  set searching(value) {
    const list = this.querySelector('printer-list');
    list.setAttribute('aria-busy', String(value));
    this.querySelector('#printer-skeleton').hidden = !value || list.childElementCount > 0;
  }

  connectedCallback() {
    super.connectedCallback();
    const panel = this;
    this.panel = this;
    this.page ??= 'root';
    this.parents = { printers: 'root', backends: 'root' };
    this.back = this.querySelector('#settings-back');
    this.listen(this.querySelector('#scan-button'), 'click', () => this.emit('printer-scan'));
    this.listen(this.back, 'click', () => this.navigate(this.parents[this.page] || 'root', false, true));
    this.listen(panel, 'click', event => {
      const row = event.target.closest('[data-settings-target]');
      if (row) this.navigate(row.dataset.settingsTarget, true, true);
    });
    this.listen(panel, 'keydown', event => {
      if (event.key === 'Escape' && this.page !== 'root') {
        this.navigate(this.parents[this.page] || 'root', false, true);
        event.preventDefault();
        event.stopPropagation();
      }
      if (event.target.matches('input, select, textarea')) return;
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      const rows = [...panel.querySelectorAll(`[data-settings-page="${this.page}"] button:not(:disabled)`)].filter(row => row.getClientRects().length);
      if (!rows.length) return;
      const index = rows.indexOf(this.ownerDocument.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 :
        (index + (event.key === 'ArrowUp' ? -1 : 1) + rows.length) % rows.length;
      rows[next].focus();
      event.preventDefault();
    });
  }

  navigate(page, search = false, focus = false) {
    if (this.page === 'printers' && page !== 'printers') this.querySelector('printer-list').closeEditor();
    if (this.page === 'backends' && page !== 'backends') this.querySelector('printer-backend-list').closeEditor();
    this.page = page;
    for (const pane of this.panel.querySelectorAll('[data-settings-page]')) pane.hidden = pane.dataset.settingsPage !== page;
    this.back.hidden = page === 'root';
    this.back.setAttribute('aria-label', 'Back to settings');
    this.updateHeading();
    this.querySelector('#scan-button').hidden = page !== 'printers' || this.canScan === false;
    if (page === 'printers' && search && this.canScan !== false) this.emit('printer-scan');
    if (focus) {
      const target = [...this.panel.querySelectorAll(`[data-settings-page="${page}"] button:not(:disabled), [data-settings-page="${page}"] input`)]
        .find(node => node.getClientRects().length);
      (target || this.back).focus({ preventScroll: true });
    }
  }

  updateHeading() {
    this.querySelector('#settings-title').textContent = {
      root: 'Settings', printers: 'Printers', backends: 'Backend',
    }[this.page];
  }
}
