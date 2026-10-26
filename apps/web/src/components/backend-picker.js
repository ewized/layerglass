import { PlayerElement } from './base.js';
import { backendConfig, saveBackend } from '../backend/config.js';
import { PythonBackend } from '../backend/python.js';
import { probeDirectPrinter, directBrowserError } from '../backend/direct.js';

export class PrinterBackendPicker extends PlayerElement {
  static template = `
    <div class="backend-welcome">
      <p class="backend-brand"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5"/></svg>LayerGlass</p>
      <section data-backend-page="choose" aria-labelledby="backend-welcome-title">
        <h1 id="backend-welcome-title">Choose your backend</h1>
        <p class="backend-intro">Try the demo or connect to your own hardware.</p>
        <div class="backend-choices">
          <button type="button" class="backend-choice" data-backend-choice="demo">
            <svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-play"/></svg>
            <span><strong>Demo</strong><span>Sample video and printer data. No setup.</span></span>
            <svg class="backend-chevron" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-chevron"/></svg>
          </button>
          <button type="button" class="backend-choice" data-backend-choice="docker">
            <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01M12 6.5h5M12 17.5h5"/></svg>
            <span><strong>Docker backend</strong><span>Connect to LayerGlass on your hardware.</span></span>
            <svg class="backend-chevron" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-chevron"/></svg>
          </button>
          <button type="button" class="backend-choice" data-backend-choice="direct">
            <svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-printer"/></svg>
            <span><strong>Direct printer</strong><span>Klipper / Moonraker live camera. No rewind. Bambu printers need Docker.</span></span>
            <svg class="backend-chevron" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-chevron"/></svg>
          </button>
        </div>
      </section>
      <section data-backend-page="docker" aria-labelledby="backend-docker-title" hidden>
        <div class="backend-heading"><button type="button" class="icon-button" data-backend-back aria-label="Back to backend choices"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-back"/></svg></button><h1 id="backend-docker-title">Docker backend</h1></div>
        <p class="backend-intro" data-connection-intro>Enter the address of your LayerGlass container.</p>
        <form class="backend-connect-form">
          <label for="backend-connect-url">Backend address</label>
          <input id="backend-connect-url" name="url" type="text" inputmode="url" autocomplete="url" autocapitalize="none" spellcheck="false" placeholder="printer.example.com" required>
          <p class="backend-address-hint"></p>
          <p class="backend-connect-error" role="alert" hidden></p>
          <button type="submit" class="button primary"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-connection"/></svg><span>Connect</span><span class="loader" aria-hidden="true" hidden></span></button>
        </form>
      </section>
      <p class="backend-footnote">Your choice stays in this browser. Change it anytime in Settings → Backend.</p>
    </div>`;

  connectedCallback() {
    super.connectedCallback();
    this.form = this.querySelector('form');
    this.input = this.querySelector('input');
    this.error = this.querySelector('.backend-connect-error');
    const unsupported = directBrowserError();
    if (unsupported) {
      const direct = this.querySelector('[data-backend-choice="direct"]');
      direct.disabled = true;
      direct.querySelector('span span').textContent = unsupported;
    }
    this.listen(this, 'click', event => {
      const choice = event.target.closest('[data-backend-choice]')?.dataset.backendChoice;
      if (choice === 'demo') this.select({ type: 'demo' });
      if (choice === 'docker') this.page('docker');
      if (choice === 'direct') this.page('direct');
      if (event.target.closest('[data-backend-back]')) this.page('choose');
    });
    this.listen(this.form, 'submit', event => { event.preventDefault(); this.connect(); });
    this.listen(this, 'keydown', event => {
      if (event.key === 'Escape' && !this.form.closest('section').hidden) { this.page('choose'); event.preventDefault(); }
    });
  }

  page(name) {
    this.cancel();
    this.error.hidden = true;
    if (name !== 'choose') this.connectionType = name === 'direct' ? 'direct' : 'python';
    for (const page of this.querySelectorAll('[data-backend-page]')) page.hidden = page.dataset.backendPage !== (name === 'choose' ? 'choose' : 'docker');
    const direct = this.connectionType === 'direct';
    this.querySelector('#backend-docker-title').textContent = direct ? 'Direct printer' : 'Docker backend';
    this.querySelector('[data-connection-intro]').textContent = direct ?
      'Connect to your existing Klipper / Moonraker controller. Live camera only; Bambu printers need Docker.' :
      'Enter the address of your LayerGlass container.';
    this.form.querySelector('label').textContent = direct ? 'Printer / controller address' : 'Backend address';
    this.input.type = direct ? 'url' : 'text';
    this.input.placeholder = direct ? 'https://klipper.example.com' : 'printer.example.com';
    this.querySelector('.backend-address-hint').textContent = this.ownerDocument.location.protocol === 'https:' ?
      direct ? 'Use an HTTPS address that this device can reach.' : 'HTTPS is automatic.' :
      'Use the address you open to view your container.';
    (name !== 'choose' ? this.input : this.querySelector(`[data-backend-choice="${direct ? 'direct' : 'docker'}"]`)).focus({ preventScroll: true });
  }

  busy(value) {
    const back = this.querySelector('[data-backend-back]');
    if (value && this.form.contains(this.ownerDocument.activeElement)) {
      // Disabling the focused input/submit button otherwise sends keyboard
      // focus to body, outside the picker's Escape cancellation handler.
      this.pendingFocus = back;
      back.focus({ preventScroll: true });
    }
    this.form.setAttribute('aria-busy', String(value));
    this.input.disabled = value;
    this.form.querySelector('[type="submit"]').disabled = value;
    this.form.querySelector('.loader').hidden = !value;
    if (!value) {
      if (this.pendingFocus === this.ownerDocument.activeElement) this.input.focus({ preventScroll: true });
      this.pendingFocus = null;
    }
  }

  async connect() {
    if (this.pending || !this.form.reportValidity()) return;
    this.error.hidden = true;
    const request = this.pending = new AbortController();
    const timer = setTimeout(() => request.abort(), 6000);
    this.busy(true);
    try {
      const config = backendConfig({ type: this.connectionType || 'python', url: this.input.value.trim() });
      if (config.type === 'direct') await probeDirectPrinter(config.url, { profile: config.profile, signal: request.signal });
      else {
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
      this.error.textContent = failure.name === 'AbortError' ? 'Connection timed out. Check the address and try again.' :
        failure instanceof TypeError && /fetch|network|load/i.test(failure.message) ?
          'Cannot reach this backend. Check HTTPS, your network, and its allowed frontend origin.' :
          failure instanceof SyntaxError ? 'This address is not a compatible LayerGlass backend.' : failure.message;
      this.error.hidden = false;
      console.warn('[LayerGlass] Backend connection failed', failure.name);
    } finally {
      clearTimeout(timer);
      if (this.pending === request) { this.pending = null; this.busy(false); }
    }
  }

  select(config) {
    try { saveBackend(config); }
    catch (_) { console.warn('[LayerGlass] Backend choice will last for this page; browser storage is unavailable.'); }
    this.emit('backend-select', config);
  }

  cancel() { this.pending?.abort(); this.pending = null; this.busy(false); }
  disconnectedCallback() { this.cancel(); super.disconnectedCallback(); }
}
