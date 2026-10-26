import type {
  CastContext,
  CastLoadRequest,
  CastMediaInfo,
  CastMediaMetadata,
  CastMediaSession,
  CastRemoteController,
  CastRemotePlayer,
} from '../src/cast-types.js';

type Listener = (event: { type: string }) => void;

class Observable {
  listeners = new Map<string, Listener[]>();
  addEventListener(type: string, listener: Listener) {
    const values = this.listeners.get(type) ?? [];
    values.push(listener);
    this.listeners.set(type, values);
  }
  removeEventListener(type: string, listener: Listener) {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((value) => value !== listener),
    );
  }
  emit(type: string) {
    for (const listener of this.listeners.get(type) ?? []) listener({ type });
  }
}

interface FixtureMediaInfo extends CastMediaInfo {
  contentType: string;
}
interface FixtureLoadRequest extends CastLoadRequest {
  media: FixtureMediaInfo;
}
export class CastFixture {
  requests: Array<{ activated: boolean | undefined }> = [];
  loads: FixtureLoadRequest[] = [];
  controls: Array<string | { seek: number }> = [];
  stops = 0;
  connected = false;
  range = { start: 0, end: 100 };
  time = 0;
  holdSession = false;
  failSession: unknown;
  failLoad: unknown;
  media: CastMediaSession | null = null;
  // The application's RemotePlayer constructors initialize these before use.
  declare player: CastRemotePlayer;
  declare controller: CastRemoteController & Observable;
  declare context: CastContext & Observable;
  declare options: Parameters<CastContext['setOptions']>[0];
  declare finishSession: () => void;
  declare cancelSession: () => void;
  declare disconnect: () => void;
  declare advance: (time: number, paused?: boolean) => void;
}

export interface CastFixtureView {
  navigator: { userActivation?: Pick<UserActivation, 'isActive'> };
  chrome?: Window['chrome'];
  cast?: Window['cast'];
  __onGCastApiAvailable?: (available: boolean) => void;
  castFixture?: CastFixture;
}

// Delivered as the external SDK script, exercising the actual loader and CSP.
export function installCastFixture(view: CastFixtureView = window): CastFixture {
  const fixture = (view.castFixture = new CastFixture());
  const session = {
    getMediaSession: () => fixture.media,
    async loadMedia(request: FixtureLoadRequest) {
      fixture.loads.push(request);
      if (fixture.failLoad) throw fixture.failLoad;
      const player = fixture.player;
      player.mediaInfo = request.media;
      player.isMediaLoaded = true;
      player.isPaused = !request.autoplay;
      player.liveSeekableRange = fixture.range;
      player.currentTime = request.currentTime ?? fixture.range.end - 2;
      fixture.media = { media: request.media, getEstimatedTime: () => player.currentTime };
      fixture.controller.emit('change');
    },
    async endSession(_stop: boolean) {
      fixture.stops++;
      fixture.disconnect();
    },
  };
  class Context extends Observable implements CastContext {
    getCurrentSession() {
      return fixture.connected ? session : null;
    }
    setOptions(options: Parameters<CastContext['setOptions']>[0]) {
      fixture.options = options;
    }
    requestSession() {
      fixture.requests.push({ activated: view.navigator.userActivation?.isActive });
      if (fixture.failSession) return Promise.reject(fixture.failSession);
      const connect = () => {
        fixture.connected = true;
        fixture.player.isConnected = true;
        this.emit('session');
      };
      if (fixture.holdSession)
        return new Promise<void>((resolve, reject) => {
          fixture.finishSession = () => {
            connect();
            resolve();
          };
          fixture.cancelSession = () => reject('cancel');
        });
      connect();
      return Promise.resolve();
    }
  }
  const context = (fixture.context = new Context());
  fixture.disconnect = () => {
    fixture.connected = false;
    fixture.player.isConnected = false;
    context.emit('session');
  };
  fixture.advance = (time, paused = fixture.player.isPaused) => {
    fixture.player.currentTime = time;
    fixture.player.isPaused = paused;
    fixture.controller.emit('change');
  };
  view.cast = {
    framework: {
      CastContext: { getInstance: () => context },
      CastContextEventType: { SESSION_STATE_CHANGED: 'session' },
      RemotePlayerEventType: { ANY_CHANGE: 'change' },
      RemotePlayer: class implements CastRemotePlayer {
        isConnected = false;
        isMediaLoaded = false;
        isPaused = false;
        currentTime = 0;
        mediaInfo?: CastRemotePlayer['mediaInfo'];
        liveSeekableRange?: CastRemotePlayer['liveSeekableRange'];
        constructor() {
          fixture.player = this;
        }
      },
      RemotePlayerController: class extends Observable implements CastRemoteController {
        player: CastRemotePlayer;
        constructor(player: CastRemotePlayer) {
          super();
          this.player = player;
          fixture.controller = this;
        }
        playOrPause() {
          fixture.controls.push('pause/play');
          this.player.isPaused = !this.player.isPaused;
          this.emit('change');
        }
        seek() {
          fixture.controls.push({ seek: this.player.currentTime });
          this.emit('change');
        }
      },
    },
  };
  view.chrome ??= {};
  view.chrome.cast = {
    isAvailable: true,
    AutoJoinPolicy: { TAB_AND_ORIGIN_SCOPED: 'tab' },
    Image: class {
      url: string;
      constructor(url: string) {
        this.url = url;
      }
    },
    media: {
      DEFAULT_MEDIA_RECEIVER_APP_ID: 'default-receiver',
      StreamType: { LIVE: 'live' },
      MediaInfo: class implements CastMediaInfo {
        contentId: string;
        contentType: string;
        streamType = '';
        declare metadata: CastMediaMetadata;
        constructor(contentId: string, contentType: string) {
          this.contentId = contentId;
          this.contentType = contentType;
        }
      },
      GenericMediaMetadata: class implements CastMediaMetadata {
        title = '';
        subtitle = '';
        images: unknown[] = [];
      },
      LoadRequest: class implements FixtureLoadRequest {
        media: FixtureMediaInfo;
        autoplay = false;
        currentTime?: number;
        constructor(media: CastMediaInfo) {
          if (!('contentType' in media) || typeof media.contentType !== 'string')
            throw new Error('Fixture media requires a content type');
          this.media = Object.assign(media, { contentType: media.contentType });
        }
      },
    },
  };
  view.__onGCastApiAvailable?.(true);
  return fixture;
}
