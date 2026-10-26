import { PlayerElement } from './base.js';
import { backendListTemplate } from './templates.js';

const labels = { python: 'Docker backend', demo: 'Demo', direct: 'Direct printer' };

// Selection and inline editing mirror printer rows. Probing and saving belong
// to the application controller; opening an editor never changes the backend.
export class PrinterBackendList extends PlayerElement {
  static template = backendListTemplate;
  drafts = new Map();

  connectedCallback() {
    super.connectedCallback();
    this.form = this.querySelector('#backend-form');
    this.input = this.querySelector('#backend-url');
    this.confirm = this.querySelector('#backend-confirm');
    this.listen(this, 'click', event => {
      const button = event.target.closest('[data-backend-select], [data-backend-edit]');
      if (!button || button.disabled || this.busy) return;
      const type = button.dataset.backendEdit || button.dataset.backendSelect;
      if (type === 'demo') {
        this.closeEditor();
        if (this.current?.type !== type) this.emit('backend-save', { type });
      } else if (button.hasAttribute('data-backend-edit') || this.current?.type !== type) this.edit(type);
    });
    this.listen(this.form, 'submit', event => {
      event.preventDefault();
      if (this.form.hidden || this.busy) return;
      this.emit('backend-save', { type: this.editing, url: this.input.value.trim() });
    });
    this.listen(this.input, 'input', () => {
      this.drafts.set(this.editing, this.input.value);
      this.error = '';
    });
    this.listen(this, 'keydown', event => {
      if (event.key !== 'Escape' || !this.editing || this.busy) return;
      const type = this.editing;
      this.closeEditor();
      this.querySelector(`[data-backend-edit="${type}"]`).focus({ preventScroll: true });
      event.preventDefault();
      event.stopPropagation();
    });
    this.render();
  }

  configure(current, directError = null) {
    this.current = current;
    this.directError = directError;
    if (current.url) this.drafts.set(current.type, current.url);
    if (this.isConnected && this.rendered) this.render();
    return labels[current.type];
  }

  render() {
    for (const button of this.querySelectorAll('[data-backend-select], [data-backend-edit]')) {
      const type = button.dataset.backendSelect || button.dataset.backendEdit;
      button.disabled = Boolean(this.busy || type === 'direct' && this.directError);
      if (button.hasAttribute('data-backend-select')) {
        const selected = type === this.current?.type;
        button.setAttribute('aria-pressed', String(selected));
        button.querySelector('.printer-state').toggleAttribute('hidden', !selected);
      }
    }
    const direct = this.querySelector('[data-backend-address="direct"]');
    direct.textContent = this.directError ? 'Unavailable in Safari / iPhone' :
      this.current?.type === 'direct' ? this.current.url : 'Klipper / Moonraker · live only';
    direct.title = this.directError || '';
    if (this.current?.type === 'python') this.querySelector('[data-backend-address="python"]').textContent = this.current.url;
    this.form.setAttribute('aria-busy', String(Boolean(this.busy)));
    this.confirm.setAttribute('aria-busy', String(Boolean(this.busy)));
    this.confirm.querySelector('use').setAttribute('href', this.busy ? '#i-refresh' : '#i-check');
    this.confirm.disabled = Boolean(this.busy);
    this.input.disabled = Boolean(this.busy || !this.editing);
  }

  edit(type) {
    if (this.busy || !['python', 'direct'].includes(type) || type === 'direct' && this.directError) return;
    if (this.editing) this.drafts.set(this.editing, this.input.value);
    this.editing = type;
    this.querySelector(`[data-backend-row="${type}"]`).append(this.form);
    this.form.hidden = false;
    this.input.value = this.drafts.get(type) || '';
    this.input.type = type === 'direct' ? 'url' : 'text';
    this.input.placeholder = type === 'direct' ? 'https://klipper.example.com' : 'printer.example.com';
    this.querySelector('#backend-url-label').textContent = type === 'direct' ? 'Printer / controller address' : 'Backend address';
    this.querySelector('#backend-capabilities').textContent = type === 'direct' ?
      'Live camera only. Bambu printers require the Docker backend.' : 'Connect to LayerGlass on your hardware.';
    this.error = '';
    this.render();
    this.input.focus({ preventScroll: true });
  }

  closeEditor() {
    if (!this.editing || this.busy) return;
    this.drafts.set(this.editing, this.input.value);
    this.editing = null;
    this.form.hidden = true;
    this.error = '';
    this.render();
  }

  set busy(value) { this.pending = value; if (this.isConnected && this.rendered) this.render(); }
  get busy() { return Boolean(this.pending); }
  set error(value) {
    const message = this.querySelector('#backend-error');
    // Demo has no address form. Storage errors must remain visible there too.
    if (!this.editing) this.append(message);
    else this.form.insertBefore(message, this.querySelector('#backend-capabilities'));
    message.textContent = value;
    message.hidden = !value;
    if (value) this.input.setAttribute('aria-invalid', 'true');
    else this.input.removeAttribute('aria-invalid');
  }
}
