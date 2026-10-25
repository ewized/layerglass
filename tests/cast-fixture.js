// Minimal SDK boundary double. It is delivered as the external vendor script
// in browser tests, so the application's real loader and CSP are still used.
export function installCastFixture(view = window) {
  class Observable {
    constructor() { this.listeners = new Map(); }
    addEventListener(type, fn) { const values = this.listeners.get(type) || []; values.push(fn); this.listeners.set(type, values); }
    emit(type) { for (const fn of this.listeners.get(type) || []) fn({ type }); }
  }
  const fixture = view.castFixture = { requests: [], loads: [], controls: [], stops: 0,
    connected: false, range: { start: 0, end: 100 }, time: 0 };
  const session = {
    getMediaSession: () => fixture.media || null,
    async loadMedia(request) {
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
    endSession(stop) { fixture.stops++; fixture.disconnect(); },
  };
  const context = new Observable();
  context.getCurrentSession = () => fixture.connected ? session : null;
  context.setOptions = options => { fixture.options = options; };
  context.requestSession = () => {
    fixture.requests.push({ activated: view.navigator.userActivation?.isActive });
    if (fixture.failSession) return Promise.reject(fixture.failSession);
    const connect = () => {
      fixture.connected = true;
      fixture.player.isConnected = true;
      context.emit('session');
    };
    if (fixture.holdSession) return new Promise((resolve, reject) => {
      fixture.finishSession = () => { connect(); resolve(); };
      fixture.cancelSession = () => reject('cancel');
    });
    connect();
    return Promise.resolve();
  };
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
  view.cast = { framework: {
    CastContext: { getInstance: () => context },
    CastContextEventType: { SESSION_STATE_CHANGED: 'session' },
    RemotePlayerEventType: { ANY_CHANGE: 'change' },
    RemotePlayer: class { constructor() { this.isConnected = false; fixture.player = this; } },
    RemotePlayerController: class extends Observable {
      constructor(player) { super(); this.player = player; fixture.controller = this; }
      playOrPause() { fixture.controls.push('pause/play'); this.player.isPaused = !this.player.isPaused; this.emit('change'); }
      seek() { fixture.controls.push({ seek: this.player.currentTime }); this.emit('change'); }
    },
  } };
  view.chrome ||= {};
  view.chrome.cast = { isAvailable: true, AutoJoinPolicy: { TAB_AND_ORIGIN_SCOPED: 'tab' },
    Image: class { constructor(url) { this.url = url; } }, media: {
      DEFAULT_MEDIA_RECEIVER_APP_ID: 'default-receiver', StreamType: { LIVE: 'live' },
      MediaInfo: class { constructor(contentId, contentType) { Object.assign(this, { contentId, contentType }); } },
      GenericMediaMetadata: class {}, LoadRequest: class { constructor(media) { this.media = media; } },
    } };
  view.__onGCastApiAvailable?.(true);
  return fixture;
}
