import { PrinterBackendPicker } from '/static/components/backend-picker.js';
customElements.define('printer-backend-picker', PrinterBackendPicker);
window.selections = [];
document
  .querySelector<HTMLElementTagNameMap['printer-backend-picker']>('#backend-picker')!
  .addEventListener('backend-select', (event) => window.selections.push(event.detail));
