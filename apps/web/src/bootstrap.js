import './pwa.js';
import { activateBackend, configuration } from './backend/index.js';
import { PrinterBackendPicker } from './components/backend-picker.js';

customElements.define('printer-backend-picker', PrinterBackendPicker);
const player = document.getElementById('player');
const picker = document.getElementById('backend-picker');

if (!configuration) {
  player.hidden = true;
  picker.hidden = false;
  const selected = await new Promise(resolve => picker.addEventListener('backend-select',
    event => resolve(event.detail), { once: true }));
  activateBackend(selected);
}
picker.remove();
player.hidden = false;
// Do not register the player, open a session, load hls.js or start media until
// its provider is known. Re-imports still share the one player module instance.
await import('./player.js');
