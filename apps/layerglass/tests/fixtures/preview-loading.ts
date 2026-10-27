import { PrinterScrubPreview } from '/static/components/scrub-preview.js';
import { PreviewHistory } from '/static/preview-history.js';
import { required } from '/static/dom.js';
import type { PageReplay } from '/static/replay.js';
import type { ReplaySession } from '../../../backend-contracts/src/index.js';
import { testDouble } from '../test-doubles.ts';
import './jpeg-bounds.ts';

customElements.define('printer-scrub-preview', PrinterScrubPreview);
const preview = required<PrinterScrubPreview>(document, 'printer-scrub-preview');

export function configurePreview(token: string, history = new PreviewHistory({ disk: null })) {
  const session = testDouble<ReplaySession>({
    session_id: token,
    ready: true,
    start_seconds: 0,
    end_seconds: 120,
  });
  const replay = {
    session,
    backend: { id: 'python' as const },
    timeline: { edge: 120 },
    bounds: () => ({ start: 0, end: 120 }),
  };
  preview.configure(() => testDouble<PageReplay>(replay), history);
  preview.slider!.min = '0';
  preview.slider!.max = '120';
  preview.slider!.disabled = false;
  const state = {
    preview,
    history,
    replay,
    reads: [] as string[],
    releases: new Map<string, () => void>(),
    release(key: string) {
      const resolve = this.releases.get(key);
      if (!resolve) throw new Error('No held preview read: ' + key);
      resolve();
      this.releases.delete(key);
    },
  };
  window.previewTest = state;
  return state;
}

window.configurePreview = configurePreview;
window.previewClock = Date.now();
Date.now = () => window.previewClock;
window.originalVideo = required<HTMLVideoElement>(document, 'video');
window.previewSeeks = 0;
window.originalVideo.addEventListener('seeking', () => window.previewSeeks++);
window.previewReady = true;
