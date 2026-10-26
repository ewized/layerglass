/** Narrow ports for Google's externally loaded sender SDK. No printer protocol lives here. */
export interface CastMediaMetadata {
  title: string;
  subtitle: string;
  images: unknown[];
}
export interface CastMediaInfo {
  contentId?: string;
  streamType: string;
  metadata: CastMediaMetadata;
}
export interface CastLoadRequest {
  autoplay: boolean;
  currentTime?: number;
}
export interface CastMediaSession {
  media?: { contentId?: string };
  getEstimatedTime?(): number;
}
export interface CastSession {
  endSession(stop: boolean): Promise<void>;
  loadMedia(request: CastLoadRequest): Promise<void>;
  getMediaSession(): CastMediaSession | null;
}
export interface CastContext {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
  setOptions(options: {
    receiverApplicationId: string;
    autoJoinPolicy: string;
    resumeSavedSession: boolean;
  }): void;
  requestSession(): Promise<void>;
  getCurrentSession(): CastSession | null;
}
export interface CastRemotePlayer {
  isConnected: boolean;
  isMediaLoaded: boolean;
  isPaused: boolean;
  currentTime: number;
  mediaInfo?: { contentId?: string };
  liveSeekableRange?: { start: number; end: number };
}
export interface CastRemoteController {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
  playOrPause(): void;
  seek(): void;
}
export interface CastFramework {
  CastContext: { getInstance(): CastContext };
  RemotePlayer: new () => CastRemotePlayer;
  RemotePlayerController: new (player: CastRemotePlayer) => CastRemoteController;
  RemotePlayerEventType: { ANY_CHANGE: string };
  CastContextEventType: { SESSION_STATE_CHANGED: string };
}
export interface CastAPI {
  isAvailable: boolean;
  AutoJoinPolicy: { TAB_AND_ORIGIN_SCOPED: string };
  Image: new (url: string) => unknown;
  media: {
    DEFAULT_MEDIA_RECEIVER_APP_ID: string;
    MediaInfo: new (source: string, type: string) => CastMediaInfo;
    GenericMediaMetadata: new () => CastMediaMetadata;
    LoadRequest: new (info: CastMediaInfo) => CastLoadRequest;
    StreamType: { LIVE: string };
  };
}
declare global {
  interface Window {
    chrome?: { cast?: CastAPI };
    cast?: { framework: CastFramework };
    __onGCastApiAvailable?: (available: boolean) => void;
    PresentationRequest?: new (url: string) => EventTarget;
    ManagedMediaSource?: typeof MediaSource;
  }
  interface Navigator {
    presentation?: EventTarget;
  }
}
