export class PlayerFullscreen {
  constructor(player, video, canAutoEnter, showControls) {
    this.player = player;
    this.video = video;
    this.canAutoEnter = canAutoEnter;
    this.showControls = showControls;
    this.button = document.getElementById('fullscreen-button');
    this.touchDevice = navigator.maxTouchPoints > 0 || matchMedia('(pointer: coarse)').matches;
    this.lastLandscape = this.landscape();
    this.entering = false;
    this.nativeRequested = false;
    this.nativeActive = false;
    this.inPage = false;
    this.exitAfterEntry = false;
    this.retryOnTap = false;
    player.addEventListener('fullscreen-toggle', () => {
      this.retryOnTap = false;
      if (this.miniActive()) this.player.dispatchEvent(new Event('playerrestore'));
      else if (this.browserFullscreen() || this.nativeFullscreen() || this.entering || this.nativeRequested ||
          (this.inPage && !this.canEnterNative())) this.exit();
      else this.enter();
    });
    // Request within the orientation event: delaying it can lose the browser's
    // permission to enter fullscreen after a physical rotation.
    screen.orientation?.addEventListener('change', () => this.rotate());
    window.addEventListener('orientationchange', () => this.rotate());
    player.addEventListener('click', event => {
      if (this.retryOnTap && this.landscape() && event.target.matches('video, #jpeg, #viewer')) this.enter(true);
    });
    for (const event of ['fullscreenchange', 'webkitfullscreenchange']) {
      document.addEventListener(event, () => this.update());
    }
    window.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !event.defaultPrevented && this.inPage) this.exit();
    });
    video.addEventListener('webkitbeginfullscreen', () => this.nativeChanged(true));
    video.addEventListener('webkitendfullscreen', () => this.nativeChanged(false));
    video.addEventListener('webkitpresentationmodechanged', () => {
      if (video.webkitPresentationMode) this.nativeChanged(video.webkitPresentationMode === 'fullscreen');
    });
    this.update();
  }

  landscape() {
    if (screen.orientation?.type) return screen.orientation.type.startsWith('landscape');
    if (typeof window.orientation === 'number') return Math.abs(window.orientation) === 90;
    return null;
  }

  browserFullscreen() {
    const element = document.fullscreenElement || document.webkitFullscreenElement;
    return element === this.player;
  }

  nativeFullscreen() {
    return this.nativeActive || this.video.webkitDisplayingFullscreen || this.video.webkitPresentationMode === 'fullscreen';
  }

  active() { return this.inPage || this.browserFullscreen() || this.nativeFullscreen(); }

  canEnterNative() {
    return !this.video.hidden && this.video.readyState >= 2 && this.video.webkitSupportsFullscreen !== false &&
      typeof this.video.webkitEnterFullscreen === 'function';
  }

  enterNative() {
    // Call directly in the button's event stack: iPhone requires activation.
    // This is only a fallback for an explicit fullscreen request; rotation
    // keeps our controls in the full-window view when element fullscreen is absent.
    this.nativeRequested = true;
    this.nativeTimer = setTimeout(() => {
      this.nativeRequested = false;
      this.update();
    }, 2000);
    this.video.webkitEnterFullscreen();
  }

  nativeChanged(active) {
    clearTimeout(this.nativeTimer);
    this.nativeRequested = false;
    this.nativeActive = active;
    this.expandInPage(false);
    if (active && this.exitAfterEntry) this.exit();
    this.update();
  }

  miniActive() {
    return this.player.classList.contains('mini-player');
  }

  expandInPage(expanded) {
    this.inPage = expanded;
    this.player.classList.toggle('expanded', expanded);
    this.video.controls = false;
  }

  rotate() {
    const landscape = this.landscape();
    if (landscape === null || landscape === this.lastLandscape) return;
    this.lastLandscape = landscape;
    if (!this.touchDevice || document.hidden) return;
    this.retryOnTap = false;
    if (landscape) {
      if (!this.miniActive() && this.canAutoEnter()) this.enter(true);
    } else this.exit();
  }

  async enter(automatic = false) {
    if (this.browserFullscreen() || this.nativeFullscreen() || this.entering || this.nativeRequested) return;
    this.entering = true;
    this.player.classList.remove('mini-player');
    this.player.dispatchEvent(new Event('playerexpanded'));
    this.exitAfterEntry = false;
    // Prefer whole-player fullscreen so the custom controls stay available.
    // An explicit button press may fall back to iPhone's native video player.
    this.expandInPage(true);
    try {
      try {
        if (this.player.requestFullscreen && document.fullscreenEnabled !== false) {
          await this.player.requestFullscreen({ navigationUI: 'hide' });
        } else if (this.player.webkitRequestFullscreen && document.webkitFullscreenEnabled !== false) {
          await this.player.webkitRequestFullscreen();
        } else if (!automatic && this.canEnterNative()) this.enterNative();
      } catch (error) {
        if (automatic || this.exitAfterEntry || this.nativeRequested || !this.canEnterNative()) throw error;
        this.enterNative();
      }
      this.retryOnTap = false;
    } catch (error) {
      clearTimeout(this.nativeTimer);
      this.nativeRequested = false;
      // Some mobile browsers require a tap even after a rotation. Reuse the
      // video surface to retry whole-player fullscreen; our controls remain
      // available in the expanded view while waiting for that gesture.
      this.retryOnTap = automatic && !this.exitAfterEntry && this.landscape();
      console.debug('[LayerGlass] Fullscreen request unavailable', error.name);
    } finally {
      this.entering = false;
      if (this.exitAfterEntry) this.exit();
      this.update();
    }
  }

  async exit() {
    this.retryOnTap = false;
    this.exitAfterEntry = this.entering || this.nativeRequested;
    this.expandInPage(false);
    try {
      if (this.nativeFullscreen()) {
        this.video.webkitExitFullscreen?.();
      } else if (document.fullscreenElement === this.player && document.exitFullscreen) {
        await document.exitFullscreen();
      } else if (document.webkitFullscreenElement === this.player) {
        await document.webkitExitFullscreen?.();
      }
    } catch (_) { /* The browser may already have exited during rotation. */ }
    this.update();
  }

  update() {
    const native = !!this.nativeFullscreen();
    this.player.classList.toggle('native-fullscreen', native);
    if (this.browserFullscreen() || native) {
      this.expandInPage(false);
      this.retryOnTap = false;
    }
    // A rotation-only page expansion must still offer real video fullscreen
    // on iPhone, rather than making the next button press just undo the expansion.
    const active = this.browserFullscreen() || native || this.nativeRequested || (this.inPage && !this.canEnterNative());
    const mini = this.miniActive();
    this.button.setAttribute('aria-label', mini ? 'Restore player' : active ? 'Exit fullscreen' : 'Enter fullscreen');
    this.button.title = mini ? 'Restore player' : active ? 'Exit fullscreen' : 'Fullscreen';
    this.button.querySelector('use').setAttribute('href', mini ? '#i-restore' : active ? '#i-exit-fullscreen' : '#i-fullscreen');
    this.showControls();
  }
}
