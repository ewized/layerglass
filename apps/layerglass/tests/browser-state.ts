import type * as HistoryReconnectTypes from './fixtures/history-reconnect.ts';
import type * as PreviewLoadingTypes from './fixtures/preview-loading.ts';
import type * as VideoStreamTypes from '../src/video-stream';
import type * as PlayerTypes from '../src/player';
import type * as CastFixtureTypes from './cast-fixture.ts';
import type * as HlsTypes from 'hls.js';
import type * as BackendContractsTypes from '../../backend-contracts/src/index';
import type * as JpegBoundsTypes from './fixtures/jpeg-bounds.ts';
import type * as BackendContractsTypes2 from '../../backend-contracts/src/index.js';
import type * as StatsTypes from '../src/components/stats';
import type * as BackendListTypes from '../src/components/backend-list.js';
import type * as OverlaysTypes from '../src/components/overlays.js';
import type * as StreamTypes from '../../local-backend/src/stream';
import type * as RefreshTypes from '../src/refresh.js';
// Browser-only test instrumentation. Excluded from production type environments.
export {};
declare global {
  var app: Window['app'];
  var previewTest: Window['previewTest'];
  var configurePreview: Window['configurePreview'];
  var jpegBounds: Window['jpegBounds'];
  var setupJpegBounds: Window['setupJpegBounds'];
  var clearPersistedPreview: Window['clearPersistedPreview'];
  var persistedPreview: Window['persistedPreview'];
  var originalVideo: Window['originalVideo'];
  var previewSeeks: Window['previewSeeks'];
  var previewJpeg: Window['previewJpeg'];
  var oldPreviewTest: Window['oldPreviewTest'];
  var readJpegBounds: Window['readJpegBounds'];
  var closeJpegBounds: Window['closeJpegBounds'];
  var previewDecodes: Window['previewDecodes'];
  interface Window {
    app: typeof HistoryReconnectTypes.app;
    ready: boolean;
    previewTest: ReturnType<typeof PreviewLoadingTypes.configurePreview>;
    configurePreview: typeof PreviewLoadingTypes.configurePreview;
    previewClock: number;
    previewReady: boolean;
    allowUserPlayback: boolean;
    automaticProbeDelays: number[];
    backendAddressFetch: ((input: RequestInfo | URL, init?: RequestInit | undefined) => Promise<Response>) & {
      (input: RequestInfo | URL, init?: RequestInit | undefined): Promise<Response>;
      (input: string | Request | URL, init?: RequestInit | undefined): Promise<Response>;
    };
    backendAddressRequests: Array<string>;
    backendFocusAttempts: Array<{ connected: boolean }>;
    backendPlaceholder: Comment;
    backendTestFetch: ((input: RequestInfo | URL, init?: RequestInit | undefined) => Promise<Response>) & {
      (input: RequestInfo | URL, init?: RequestInit | undefined): Promise<Response>;
      (input: string | Request | URL, init?: RequestInit | undefined): Promise<Response>;
    };
    backendTestReject: (reason?: unknown) => void;
    backendTestRequests: number;
    backendTestURL: string;
    browserExitFullscreen: () => void;
    cancelledTransport: VideoStreamTypes.PlayerVideoStream | null;
    castApp: typeof PlayerTypes;
    castCalls: Array<{ kind: string; activated: boolean } | { kind: unknown; activated: boolean }>;
    castFixture: CastFixtureTypes.CastFixture;
    castOriginal: {
      video: HTMLVideoElement;
      decoder: HlsTypes.default | null;
      source: string;
      session: string;
      updates: BackendContractsTypes.BackendEvents | EventSource | null;
      time: number;
    };
    castUpdates: unknown;
    clearPersistedPreview: (fixture: Window['previewTest']) => Promise<void>;
    clipboardAttempt: { active: boolean; focused: boolean; allowed: boolean | undefined; error?: string };
    closeJpegBounds: typeof JpegBoundsTypes.closeJpegBounds;
    commits: number;
    completeFullscreen: () => unknown;
    completeNativeFullscreen: () => void;
    componentCamera: BackendContractsTypes2.CameraInfo;
    componentInput: HTMLInputElement | null;
    componentSaves: Array<{ cameraId: string; code: string }>;
    componentSession: string;
    componentStats: StatsTypes.PrinterStats;
    componentVideo: HTMLVideoElement;
    componentVideoCells: (string | HTMLElement | undefined)[][];
    copyFocusCommits: number;
    copyFocusOriginal: { video: HTMLVideoElement; decoder: HlsTypes.default | null; token: string };
    copyMode: string;
    debugOriginal: { decoder: HlsTypes.default | null; session: string };
    decoderAttachments: number;
    detachedBackendList: BackendListTypes.PrinterBackendList;
    diffusionOriginal: {
      video: HTMLVideoElement;
      decoder: HlsTypes.default | null;
      session: string;
      frames: number;
    };
    diffusionReads: Array<{ width: number; height: number; attached: boolean; at: number }>;
    disconnectedCopyMenu: OverlaysTypes.PrinterContextMenu;
    documentPipCalls: number;
    draftInput: HTMLInputElement;
    eventCalls: number[];
    eventCounts: { catalog: number; heartbeat: number };
    eventEmits: { id: string; position: number }[];
    eventNativeSeeks: number;
    EventSource: typeof EventSource | undefined;
    eventVideo: unknown;
    failBackendStorage: boolean;
    fallbackHls: HlsTypes.default | null;
    denyCast?: boolean;
    finishCast: () => void;
    finishCopy: () => void;
    finishDebugCopy: () => void;
    fixtureHidden: boolean;
    fixtureNativeOnline: boolean;
    fixtureOnline: boolean;
    fullscreenCalls: { action: string; activated?: boolean }[];
    orientationCalls: string[];
    heldMedia: Map<
      VideoStreamTypes.PlayerVideoStream,
      Parameters<VideoStreamTypes.PlayerVideoStream['accept']>[]
    >;
    historyDecoder: HlsTypes.default | null;
    holdInitialMedia: boolean;
    holdNextJpegDecode: boolean;
    jpegBounds: JpegBoundsTypes.JpegBoundsFixture | null;
    keyboardPip: boolean;
    keyboardPipCalls: number;
    keyboardSession: string;
    keyboardVideo: HTMLVideoElement;
    loadingObserver: MutationObserver;
    loadingPositions: Array<number>;
    loadingWrites: number;
    markerSeeks: Array<number>;
    markerSession: string;
    markerVideo: HTMLVideoElement;
    mediaActions: Map<string, (details?: Partial<MediaSessionActionDetails>) => void>;
    mediaApp: typeof PlayerTypes;
    miniFullscreenCalls: number;
    miniVideo: HTMLVideoElement | null;
    nativeProgressFrames: number;
    nativeSeeks: number;
    nativeShouldFail: boolean;
    nativeTransitions: { seeked: number; pause: number; play: number; playing: number };
    newCameraHls: HlsTypes.default | null;
    oldPreviewTest: Window['previewTest'];
    originalBackendInput: HTMLInputElement;
    originalFullscreenMedia: {
      video: HTMLVideoElement;
      decoder: HlsTypes.default | null;
      source: string;
      session: string;
      updates: BackendContractsTypes.BackendEvents | EventSource | null;
    };
    originalHls: HlsTypes.default | null;
    originalMedia: {
      video: HTMLVideoElement;
      decoder: HlsTypes.default | null;
      source: string;
      session: string;
    };
    originalPip: {
      video: HTMLVideoElement;
      decoder: HlsTypes.default | null;
      source: string;
      session: string;
      updates: BackendContractsTypes.BackendEvents | EventSource | null;
      header: Element | null;
      slider: HTMLInputElement | null;
      stats: StatsTypes.PrinterStats | null;
    };
    originalSession: unknown;
    originalVideo: HTMLVideoElement;
    pendingTransport: VideoStreamTypes.PlayerVideoStream | null;
    persistedPreview: (token: string) => Promise<Window['previewTest']>;
    pipApp: typeof PlayerTypes;
    pipBackground: { end: number; frames: number };
    pipCalls: Array<string>;
    pipScrubCommits: number;
    previewDecodes: number;
    previewJpeg: Blob;
    previewSeeks: number;
    previewTestSession: { session_id: string; ready: boolean; start_seconds: number; end_seconds: number };
    previousDirectStream: StreamTypes.DirectMjpegStream | null;
    previousTransport: VideoStreamTypes.PlayerVideoStream | null;
    priorHls: HlsTypes.default | null;
    pwaMigrationMarker: boolean;
    pwaPipCheck: { video: HTMLVideoElement; hls: HlsTypes.default | null; session: string };
    pwaPreviousController: ServiceWorker | null;
    readinessDeadlines: number;
    readJpegBounds: typeof JpegBoundsTypes.readJpegBounds;
    recoverySeeks: number;
    releaseJpegDecode: (value: void | PromiseLike<void>) => void;
    reloadPlayCalls: Array<{ muted: boolean; inline: unknown; ready: number }>;
    remoteState: string;
    restoreLoads: number;
    retryDelays: number[];
    rotatePhone: (value: boolean) => void;
    scanFixture: BackendContractsTypes2.CameraCatalog;
    scrubCommits: number;
    scrubOriginalBuffering: { maxSegments: number; backBufferLength: number };
    scrubSeeks: number;
    scrubStreamOpens: Array<{
      start: number | null;
      at: number;
      commits: number;
      gesture: 'wheel' | 'pointer' | 'keyboard' | null;
      current: number;
    }>;
    sdkRecoveryOriginal: { video: HTMLVideoElement; session: string };
    selections: BackendContractsTypes2.BackendConfiguration[];
    settingsVideo: HTMLVideoElement;
    setupJpegBounds: typeof JpegBoundsTypes.setupJpegBounds;
    stateAtStartup: {
      printerCameraReload?: ReturnType<typeof RefreshTypes.PlayerReload.consume>;
      testAutoplayMode?: string;
    } | null;
    statsNext: ChildNode | null;
    statsParent: HTMLElement | null;
    statsReads: number;
    streamTestEvents: Array<
      | { type: string; stack: string | undefined; at: number }
      | { type: string; at: number; time: unknown; paused: unknown; ready: unknown }
    >;
  }
  interface Document {
    permissionsPolicy?: { allowsFeature(feature: string): boolean };
  }
  interface Window {
    documentPictureInPicture?: { window: Window | null; requestWindow(): Promise<Window> };
  }
}
