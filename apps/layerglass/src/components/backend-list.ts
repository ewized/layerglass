import type { BackendConfiguration } from '../../../backend-contracts/src/index.js';
import { eventElement } from '../dom.js';
import { PlayerElement } from './base.js';
import { backendListTemplate } from './templates.js';

const labels = { python: 'Docker backend', demo: 'Demo', direct: 'Direct printer' };

// Selection and inline editing mirror printer rows. Probing and saving belong
// to the application controller; opening an editor never changes the backend.
export class PrinterBackendList extends PlayerElement {
  declare form: HTMLFormElement;
  declare input: HTMLInputElement;
  declare confirm: HTMLButtonElement;
  declare current: BackendConfiguration | null;
  declare directError: string | null;
  declare editing: 'python' | 'direct' | null;
  declare pending: boolean;

  static override template = backendListTemplate;
  drafts = new Map<string, string>();

  override connectedCallback() {
    super.connectedCallback();
    this.form = this.required<HTMLFormElement>('#backend-form');
    this.input = this.required<HTMLInputElement>('#backend-url');
    this.confirm = this.required<HTMLButtonElement>('#backend-confirm');
    this.listen(this, 'click', (event) => {
      const button = eventElement(event).closest<HTMLButtonElement>(
        '[data-backend-select], [data-backend-edit]',
      );
      if (!button || button.disabled || this.busy) return;
      const type = button.dataset.backendEdit || button.dataset.backendSelect;
      if (type === 'demo') {
        this.closeEditor();
        if (this.current?.type !== type) this.emit('backend-save', { type });
      } else if (button.hasAttribute('data-backend-edit') || this.current?.type !== type) this.edit(type);
    });
    this.listen(this.form, 'submit', (event) => {
      event.preventDefault();
      if (this.form.hidden || this.busy) return;
      this.emit('backend-save', { type: this.editing, url: this.input.value.trim() });
    });
    this.listen(this.input, 'input', () => {
      if (this.editing) this.drafts.set(this.editing, this.input.value);
      this.error = '';
    });
    this.listen(this, 'keydown', (event) => {
      if (event.key !== 'Escape' || !this.editing || this.busy) return;
      const type = this.editing;
      this.closeEditor();
      this.required<HTMLButtonElement>(`[data-backend-edit="${type}"]`).focus({ preventScroll: true });
      event.preventDefault();
      event.stopPropagation();
    });
    this.renderPresentation();
  }

  configure(current: BackendConfiguration, directError: string | null = null) {
    this.current = current;
    this.directError = directError;
    if ('url' in current && current.url) this.drafts.set(current.type, current.url);
    if (this.isConnected && this.rendered) this.renderPresentation();
    return labels[current.type];
  }

  renderPresentation() {
    for (const button of this.querySelectorAll<HTMLButtonElement>(
      '[data-backend-select], [data-backend-edit]',
    )) {
      const type = button.dataset.backendSelect || button.dataset.backendEdit;
      button.disabled = Boolean(this.busy || (type === 'direct' && this.directError));
      if (button.hasAttribute('data-backend-select')) {
        const selected = type === this.current?.type;
        button.setAttribute('aria-pressed', String(selected));
        button.querySelector('.printer-state')!.toggleAttribute('hidden', !selected);
      }
    }
    const direct = this.required('[data-backend-address="direct"]');
    direct.textContent = this.directError
      ? 'Unavailable in Safari / iPhone'
      : this.current?.type === 'direct'
        ? this.current.url
        : 'Klipper / Moonraker · live only';
    direct.title = this.directError || '';
    if (this.current?.type === 'python')
      this.required('[data-backend-address="python"]').textContent = this.current.url;
    this.form.setAttribute('aria-busy', String(Boolean(this.busy)));
    this.confirm.setAttribute('aria-busy', String(Boolean(this.busy)));
    this.confirm.querySelector('use')!.setAttribute('href', this.busy ? '#i-refresh' : '#i-check');
    this.confirm.disabled = Boolean(this.busy);
    this.input.disabled = Boolean(this.busy || !this.editing);
  }

  edit(type: string | undefined) {
    if (this.busy || (type !== 'python' && type !== 'direct') || (type === 'direct' && this.directError))
      return;
    if (this.editing) if (this.editing) this.drafts.set(this.editing, this.input.value);
    this.editing = type;
    this.required(`[data-backend-row="${type}"]`).append(this.form);
    this.form.hidden = false;
    this.input.value = this.drafts.get(type) || '';
    this.input.type = type === 'direct' ? 'url' : 'text';
    this.input.placeholder = type === 'direct' ? 'https://klipper.example.com' : 'printer.example.com';
    this.required('#backend-url-label').textContent =
      type === 'direct' ? 'Printer / controller address' : 'Backend address';
    this.required('#backend-capabilities').textContent =
      type === 'direct'
        ? 'Live camera only. Bambu printers require the Docker backend.'
        : 'Connect to LayerGlass on your hardware.';
    this.error = '';
    this.renderPresentation();
    this.input.focus({ preventScroll: true });
  }

  closeEditor() {
    if (!this.editing || this.busy) return;
    if (this.editing) this.drafts.set(this.editing, this.input.value);
    this.editing = null;
    this.form.hidden = true;
    this.error = '';
    this.renderPresentation();
  }

  set busy(value: boolean) {
    this.pending = value;
    if (this.isConnected && this.rendered) this.renderPresentation();
  }
  get busy() {
    return Boolean(this.pending);
  }
  set error(value: string) {
    const message = this.required('#backend-error');
    // Demo has no address form. Storage errors must remain visible there too.
    if (!this.editing) this.append(message);
    else this.form.insertBefore(message, this.required('#backend-capabilities'));
    message.textContent = value;
    message.hidden = !value;
    if (value) this.input.setAttribute('aria-invalid', 'true');
    else this.input.removeAttribute('aria-invalid');
  }
}
