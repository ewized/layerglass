import { PrinterPlayer } from './player.js';
import { PrinterControls } from './controls.js';
import { PrinterScrubPreview } from './scrub-preview.js';
import { PrinterSettings } from './settings.js';
import { PrinterItem, PrinterList } from './printers.js';
import { PrinterStats } from './stats.js';
import { PrinterLoading, PrinterCameraView, PrinterPullIndicator, PrinterContextMenu } from './overlays.js';

export const components = new Map([
  ['printer-loading', PrinterLoading],
  ['printer-camera-view', PrinterCameraView],
  ['printer-pull-indicator', PrinterPullIndicator],
  ['printer-scrub-preview', PrinterScrubPreview],
  ['printer-controls', PrinterControls],
  ['printer-item', PrinterItem],
  ['printer-list', PrinterList],
  ['printer-settings', PrinterSettings],
  ['printer-context-menu', PrinterContextMenu],
  ['printer-stats', PrinterStats],
  ['printer-player', PrinterPlayer],
]);

// Define children first; upgrading the player synchronously renders its UI.
for (const [tag, component] of components) {
  if (!customElements.get(tag)) customElements.define(tag, component);
}
