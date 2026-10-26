import type { PrinterPlayer } from '../apps/layerglass/src/components/player.js';
import type { PrinterControls } from '../apps/layerglass/src/components/controls.js';
import type { PrinterSettings } from '../apps/layerglass/src/components/settings.js';
import type { PrinterBackendPicker } from '../apps/layerglass/src/components/backend-picker.js';
import type { PrinterBackendList } from '../apps/layerglass/src/components/backend-list.js';
import type { PrinterList, PrinterItem } from '../apps/layerglass/src/components/printers.js';
import type { PrinterScrubPreview } from '../apps/layerglass/src/components/scrub-preview.js';
import type { PrinterTimelineMarkers } from '../apps/layerglass/src/components/timeline-events.js';
import type { PrinterStats } from '../apps/layerglass/src/components/stats.js';
import type {
  PrinterLoading,
  PrinterCameraView,
  PrinterContextMenu,
  PrinterPullIndicator,
} from '../apps/layerglass/src/components/overlays.js';

declare global {
  interface HTMLElementTagNameMap {
    'printer-player': PrinterPlayer;
    'printer-controls': PrinterControls;
    'printer-settings': PrinterSettings;
    'printer-backend-picker': PrinterBackendPicker;
    'printer-backend-list': PrinterBackendList;
    'printer-list': PrinterList;
    'printer-item': PrinterItem;
    'printer-scrub-preview': PrinterScrubPreview;
    'printer-timeline-events': PrinterTimelineMarkers;
    'printer-stats': PrinterStats;
    'printer-loading': PrinterLoading;
    'printer-camera-view': PrinterCameraView;
    'printer-context-menu': PrinterContextMenu;
    'printer-pull-indicator': PrinterPullIndicator;
  }
  interface HTMLVideoElement {
    webkitDecodedFrameCount?: number;
    webkitDroppedFrameCount?: number;
    webkitDisplayingFullscreen?: boolean;
    webkitSupportsFullscreen?: boolean;
    webkitEnterFullscreen?(): void;
    webkitExitFullscreen?(): void;
    webkitPresentationMode?: string;
    webkitSupportsPresentationMode?(mode: string): boolean;
    webkitSetPresentationMode?(mode: string): void;
    webkitShowPlaybackTargetPicker?(): void;
    webkitCurrentPlaybackTargetIsWireless?: boolean;
  }
  interface WindowEventMap {
    playerviewchange: Event;
    replaypositionchange: Event;
    replayexpired: Event;
  }
}

declare global {
  interface GlobalEventHandlersEventMap {
    'backend-select': CustomEvent<import('../apps/backend-contracts/src/index.js').BackendConfiguration>;
    'backend-save': CustomEvent<unknown>;
    'printer-edit': CustomEvent<{ cameraId: string }>;
    'printer-select': CustomEvent<{ cameraId: string }>;
    'printer-forget': CustomEvent<{ cameraId: string }>;
    'printer-save': CustomEvent<{ cameraId: string; code: string }>;
    'player-action': CustomEvent<{ action: string; keyboard: boolean }>;
    'stats-change': CustomEvent<{ open: boolean }>;
    replaypreviewchange: CustomEvent<{ active: boolean; kind: string | null; cancelled?: boolean }>;
  }
  interface HTMLVideoElement {
    getStartDate?(): Date;
  }
  interface Document {
    webkitFullscreenElement?: Element | null;
    webkitFullscreenEnabled?: boolean;
    webkitExitFullscreen?(): Promise<void>;
  }
  interface HTMLElement {
    webkitRequestFullscreen?(): Promise<void>;
  }
  interface Navigator {
    standalone?: boolean;
  }
}
