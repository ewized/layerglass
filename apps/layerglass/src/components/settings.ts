import { eventElement } from '../dom.js';
import { PlayerElement } from './base.js';
import { settingsTemplate } from './templates.js';

export class PrinterSettings extends PlayerElement {
  declare panel: PrinterSettings;
  declare page: 'root' | 'printers' | 'backends';
  declare parents: Partial<Record<'root' | 'printers' | 'backends', 'root'>>;
  declare back: HTMLButtonElement;
  declare canScan: boolean;

  static override template = settingsTemplate;

  set busy(value: boolean) {
    this.required<HTMLButtonElement>('#settings-back').disabled = value;
  }

  set discoveryEnabled(value: boolean) {
    this.canScan = value;
    this.required<HTMLButtonElement>('#scan-button').hidden = this.page !== 'printers' || !value;
  }

  set searching(value: boolean) {
    const list = this.required<HTMLElementTagNameMap['printer-list']>('printer-list');
    list.setAttribute('aria-busy', String(value));
    this.required('#printer-skeleton').hidden = !value || list.childElementCount > 0;
  }

  override connectedCallback() {
    super.connectedCallback();
    this.panel = this;
    this.page ??= 'root';
    this.parents = { printers: 'root', backends: 'root' };
    this.back = this.required<HTMLButtonElement>('#settings-back');
    this.listen(this.required<HTMLButtonElement>('#scan-button'), 'click', () => this.emit('printer-scan'));
    this.listen(this.back, 'click', () => this.navigate(this.parents[this.page] || 'root', false, true));
    this.listen(this, 'click', (event) => {
      const row = eventElement(event).closest<HTMLElement>('[data-settings-target]');
      if (row) this.navigate(row.dataset.settingsTarget as 'printers' | 'backends', true, true);
    });
    this.listen(this, 'keydown', (event) => {
      if (event.key === 'Escape' && this.page !== 'root') {
        this.navigate(this.parents[this.page] || 'root', false, true);
        event.preventDefault();
        event.stopPropagation();
      }
      if (eventElement(event).matches('input, select, textarea')) return;
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      const rows = [
        ...this.querySelectorAll<HTMLButtonElement>(
          `[data-settings-page="${this.page}"] button:not(:disabled)`,
        ),
      ].filter((row) => row.getClientRects().length);
      if (!rows.length) return;
      const index = rows.indexOf(this.ownerDocument.activeElement as HTMLButtonElement);
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? rows.length - 1
            : (index + (event.key === 'ArrowUp' ? -1 : 1) + rows.length) % rows.length;
      rows[next]!.focus();
      event.preventDefault();
    });
  }

  navigate(page: 'root' | 'printers' | 'backends', search = false, focus = false) {
    if (this.page === 'printers' && page !== 'printers')
      this.required<HTMLElementTagNameMap['printer-list']>('printer-list').closeEditor();
    if (this.page === 'backends' && page !== 'backends')
      this.required<HTMLElementTagNameMap['printer-backend-list']>('printer-backend-list').closeEditor();
    this.page = page;
    for (const pane of this.panel.querySelectorAll<HTMLElement>('[data-settings-page]'))
      pane.hidden = pane.dataset.settingsPage !== page;
    this.back.hidden = page === 'root';
    this.back.setAttribute('aria-label', 'Back to settings');
    this.updateHeading();
    this.required<HTMLButtonElement>('#scan-button').hidden = page !== 'printers' || this.canScan === false;
    if (page === 'printers' && search && this.canScan !== false) this.emit('printer-scan');
    if (focus) {
      const target = [
        ...this.panel.querySelectorAll<HTMLButtonElement>(
          `[data-settings-page="${page}"] button:not(:disabled), [data-settings-page="${page}"] input`,
        ),
      ].find((node) => node.getClientRects().length);
      (target || this.back).focus({ preventScroll: true });
    }
  }

  updateHeading() {
    this.required('#settings-title').textContent = {
      root: 'Settings',
      printers: 'Printers',
      backends: 'Backend',
    }[this.page];
  }
}
