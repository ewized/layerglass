import { cancelTimeout } from '../../../backend-contracts/src/index.js';
import type { BackendConfiguration } from '../../../backend-contracts/src/index.js';
import { errorName, errorMessage } from '../../../backend-contracts/src/index.js';
import { eventElement } from '../dom.js';
import { backendPickerTemplate } from './backend-template.js';
import { PlayerElement } from './base.js';
import { backendConfig, saveBackend } from '../backend/config.js';
import { PythonBackend } from '../backend/python.js';
import { probeDirectPrinter, directBrowserError } from '../backend/direct.js';

export class PrinterBackendPicker extends PlayerElement {
  declare form: HTMLFormElement;
  declare input: HTMLInputElement;
  declare error: HTMLElement;
  declare connectionType: 'python' | 'direct' | undefined;
  declare pending: AbortController | null;
  declare pendingFocus: HTMLElement | null;

  static override template = backendPickerTemplate;

  override connectedCallback() {
    super.connectedCallback();
    this.form = this.required<HTMLFormElement>('form');
    this.input = this.required<HTMLInputElement>('input');
    this.error = this.required('.backend-connect-error');
    const unsupported = directBrowserError();
    if (unsupported) {
      const direct = this.required<HTMLButtonElement>('[data-backend-choice="direct"]');
      direct.disabled = true;
      direct.querySelector('span span')!.textContent = unsupported;
    }
    this.listen(this, 'click', (event) => {
      const choice = eventElement(event).closest<HTMLElement>('[data-backend-choice]')?.dataset.backendChoice;
      if (choice === 'demo') this.select({ type: 'demo' });
      if (choice === 'docker') this.page('docker');
      if (choice === 'direct') this.page('direct');
      if (eventElement(event).closest('[data-backend-back]')) this.page('choose');
    });
    this.listen(this.form, 'submit', (event) => {
      event.preventDefault();
      this.connect();
    });
    this.listen(this, 'keydown', (event) => {
      if (event.key === 'Escape' && !this.form.closest('section')!.hidden) {
        this.page('choose');
        event.preventDefault();
      }
    });
  }

  page(name: 'choose' | 'docker' | 'direct') {
    this.cancel();
    this.error.hidden = true;
    if (name !== 'choose') this.connectionType = name === 'direct' ? 'direct' : 'python';
    for (const page of this.querySelectorAll<HTMLElement>('[data-backend-page]'))
      page.hidden = page.dataset.backendPage !== (name === 'choose' ? 'choose' : 'docker');
    const direct = this.connectionType === 'direct';
    this.required('#backend-docker-title').textContent = direct ? 'Direct printer' : 'Docker backend';
    this.required('[data-connection-intro]').textContent = direct
      ? 'Connect to your existing Klipper / Moonraker controller. Live camera only; Bambu printers need Docker.'
      : 'Enter the address of your LayerGlass container.';
    this.form.querySelector('label')!.textContent = direct
      ? 'Printer / controller address'
      : 'Backend address';
    this.input.type = direct ? 'url' : 'text';
    this.input.placeholder = direct ? 'https://klipper.example.com' : 'printer.example.com';
    this.required('.backend-address-hint').textContent =
      this.ownerDocument.location.protocol === 'https:'
        ? direct
          ? 'Use an HTTPS address that this device can reach.'
          : 'HTTPS is automatic.'
        : 'Use the address you open to view your container.';
    (name !== 'choose'
      ? this.input
      : this.required(`[data-backend-choice="${direct ? 'direct' : 'docker'}"]`)
    ).focus({ preventScroll: true });
  }

  busy(value: boolean) {
    const back = this.required<HTMLButtonElement>('[data-backend-back]');
    if (value && this.form.contains(this.ownerDocument.activeElement)) {
      // Disabling the focused input/submit button otherwise sends keyboard
      // focus to body, outside the picker's Escape cancellation handler.
      this.pendingFocus = back;
      back.focus({ preventScroll: true });
    }
    this.form.setAttribute('aria-busy', String(value));
    this.input.disabled = value;
    this.form.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled = value;
    this.form.querySelector<HTMLElement>('.loader')!.hidden = !value;
    if (!value) {
      if (this.pendingFocus === this.ownerDocument.activeElement) this.input.focus({ preventScroll: true });
      this.pendingFocus = null;
    }
  }

  async connect() {
    if (this.pending || !this.form.reportValidity()) return;
    this.error.hidden = true;
    const request = (this.pending = new AbortController());
    const timer = setTimeout(() => request.abort(), 6000);
    this.busy(true);
    try {
      const config = backendConfig({ type: this.connectionType || 'python', url: this.input.value.trim() });
      if (config.type === 'direct')
        await probeDirectPrinter(config.url, { profile: config.profile, signal: request.signal });
      else if (config.type === 'python') {
        const candidate = new PythonBackend(config.url);
        const response = await candidate.fetch('/api/backend', { signal: request.signal, cache: 'no-store' });
        const description = await response.json();
        if (!response.ok || description.id !== 'python' || description.protocol_version !== 1) {
          throw new Error('This address is not a compatible LayerGlass backend.');
        }
      }
      if (this.pending === request) this.select(config);
    } catch (failure) {
      if (this.pending !== request) return;
      this.error.textContent =
        errorName(failure) === 'AbortError'
          ? 'Connection timed out. Check the address and try again.'
          : failure instanceof TypeError && /fetch|network|load/i.test(failure.message)
            ? 'Cannot reach this backend. Check HTTPS, your network, and its allowed frontend origin.'
            : failure instanceof SyntaxError
              ? 'This address is not a compatible LayerGlass backend.'
              : errorMessage(failure);
      this.error.hidden = false;
      console.warn('[LayerGlass] Backend connection failed', errorName(failure));
    } finally {
      cancelTimeout(timer);
      if (this.pending === request) {
        this.pending = null;
        this.busy(false);
      }
    }
  }

  select(config: BackendConfiguration) {
    try {
      saveBackend(config);
    } catch (_) {
      console.warn('[LayerGlass] Backend choice will last for this page; browser storage is unavailable.');
    }
    this.emit('backend-select', config);
  }

  cancel() {
    this.pending?.abort();
    this.pending = null;
    this.busy(false);
  }
  override disconnectedCallback() {
    this.cancel();
    super.disconnectedCallback();
  }
}
