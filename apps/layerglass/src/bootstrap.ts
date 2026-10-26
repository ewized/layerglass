import { playerElement } from './dom.js';
import type { BackendConfiguration } from '../../backend-contracts/src/index.js';
import { playerStyles } from './styles.js';
playerStyles(document);
import './pwa.js';
import { activateBackend, configuration } from './backend/index.js';
import { PrinterBackendPicker } from './components/backend-picker.js';

customElements.define('printer-backend-picker', PrinterBackendPicker);
const player = playerElement(document, 'player');
const picker = playerElement(document, 'backend-picker');

if (!configuration) {
  player.hidden = true;
  picker.hidden = false;
  const selected = await new Promise<BackendConfiguration>((resolve) =>
    picker.addEventListener('backend-select', (event) => resolve(event.detail), { once: true }),
  );
  activateBackend(selected);
}
picker.remove();
player.hidden = false;
// Do not register the player, open a session, load hls.js or start media until
// its provider is known. Re-imports still share the one player module instance.
await import('./player.js');
