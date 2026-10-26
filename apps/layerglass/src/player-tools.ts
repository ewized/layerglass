import { errorName } from '../../backend-contracts/src/index.js';
import { required, eventElement } from './dom.js';
import type { PlayerFullscreen } from './player-ui.js';
import type { ReadPlayerState } from './player-state.js';
import { setNativePictureInPicture } from './visibility.js';
import { debugInfo, writeDebugClipboard } from './debug-info.js';

export class PlayerTools {
  declare player: HTMLElementTagNameMap['printer-player'];
  declare video: HTMLVideoElement;
  declare image: HTMLImageElement;
  declare chrome: HTMLElementTagNameMap['printer-player'];
  declare fullscreen: PlayerFullscreen;
  declare readState: ReadPlayerState;
  declare menu: HTMLElementTagNameMap['printer-context-menu'];
  declare stats: HTMLElementTagNameMap['printer-stats'];
  declare copyingDebug: boolean;
  declare miniOpening: boolean;

  constructor(
    player: HTMLElementTagNameMap['printer-player'],
    video: HTMLVideoElement,
    image: HTMLImageElement,
    chrome: HTMLElementTagNameMap['printer-player'],
    fullscreen: PlayerFullscreen,
    readState: ReadPlayerState,
  ) {
    Object.assign(this, { player, video, image, chrome, fullscreen, readState });
    this.menu = required<HTMLElementTagNameMap['printer-context-menu']>(document, '#video-context-menu');
    this.stats = required<HTMLElementTagNameMap['printer-stats']>(document, '#player-stats');
    this.stats.configure({ readState, video, image, player });
    this.stats.addEventListener('stats-change', () => chrome.show());
    player.addEventListener('contextmenu', (event) => {
      if (eventElement(event).closest('input, select, textarea, #player-options, #player-stats')) return;
      event.preventDefault();
      this.openMenu(event.clientX, event.clientY);
    });
    player.addEventListener(
      'keydown',
      (event) => {
        if (
          (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) &&
          (event.target === player || eventElement(event).matches('video, #jpeg, #viewer'))
        ) {
          event.preventDefault();
          const rect = player.getBoundingClientRect();
          this.openMenu(rect.left + rect.width / 2, rect.top + rect.height / 2);
        }
        if (event.key !== 'Escape') return;
        if (!this.menu.hidden) {
          this.closeMenu(true);
          event.preventDefault();
          event.stopPropagation();
        } else if (!this.stats.hidden && chrome.panel.hidden) {
          this.showStats(false, { focus: true });
          event.preventDefault();
          event.stopPropagation();
        }
      },
      true,
    );
    player.addEventListener(
      'click',
      (event) => {
        if (
          !this.menu.hidden &&
          !this.menu.contains(eventElement(event)) &&
          eventElement(event).matches('video, #jpeg, #viewer')
        ) {
          this.closeMenu();
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      },
      true,
    );
    player.addEventListener('player-action', (event) => {
      if (event.detail.action === 'copy-debug') {
        this.copyDebugInfo();
        return;
      }
      const focus = Boolean(
        event.detail.keyboard && this.menu.contains(this.player.ownerDocument.activeElement),
      );
      this.closeMenu();
      chrome.options(false);
      if (event.detail.action === 'stats') this.showStats(Boolean(this.stats.hidden), { focus });
      else if (event.detail.action === 'mini') this.toggleMini();
    });
    player.addEventListener('playerrestore', () => this.restoreMini());
    for (const event of ['loadedmetadata', 'loadeddata', 'emptied'])
      video.addEventListener(event, () => this.updateMini());
    for (const event of ['enterpictureinpicture', 'leavepictureinpicture', 'webkitpresentationmodechanged']) {
      video.addEventListener(event, () => this.syncNativeMini());
    }
    player.addEventListener('playerexpanded', () => this.updateMini());
    this.syncNativeMini();
  }

  openMenu(x: number, y: number) {
    this.chrome.options(false);
    this.updateMini();
    this.menu.openAt(x, y, this.player);
    this.chrome.show();
  }

  closeMenu(focus = false) {
    this.menu.close(focus);
  }

  async copyDebugInfo() {
    if (this.copyingDebug) return;
    this.copyingDebug = true;
    const revision = this.menu.openRevision;
    try {
      const document = this.player.ownerDocument;
      const report = debugInfo(this.readState(), this, document.defaultView!);
      await writeDebugClipboard(document, JSON.stringify(report, null, 2));
      if (this.menu.openRevision === revision && !this.menu.hidden) this.menu.copyFeedback(true);
      console.info('[LayerGlass] Debug info copied');
    } catch (error) {
      if (this.menu.openRevision === revision && !this.menu.hidden) this.menu.copyFeedback(false);
      console.warn('[LayerGlass] Could not copy debug info', errorName(error));
    } finally {
      this.copyingDebug = false;
    }
  }

  async toggleMini() {
    if (this.miniOpening) return;
    if (this.fullscreen.miniActive()) {
      await this.restoreMini();
      return;
    }
    this.miniOpening = true;
    const exiting = this.fullscreen.exit();
    try {
      // Standard video PiP also works on HTTP; Safari may use its WebKit API.
      await this.requestNativeMini();
      await exiting;
      this.syncNativeMini();
      this.chrome.show();
    } catch (error) {
      this.syncNativeMini();
      console.warn('[LayerGlass] Picture in picture unavailable', errorName(error));
    } finally {
      this.miniOpening = false;
      this.updateMini();
    }
  }

  webkitMiniSupported() {
    return (
      typeof this.video.webkitSetPresentationMode === 'function' &&
      this.video.webkitSupportsPresentationMode?.('picture-in-picture')
    );
  }

  nativeMiniMode() {
    if (this.video.ownerDocument.pictureInPictureElement === this.video) return 'standard';
    if (this.video.webkitPresentationMode === 'picture-in-picture') return 'webkit';
    return null;
  }

  async requestNativeMini() {
    if (this.video.hidden || !this.video.readyState)
      throw new DOMException('Video is not ready for picture in picture.', 'NotSupportedError');
    if (
      typeof this.video.requestPictureInPicture === 'function' &&
      this.video.ownerDocument.pictureInPictureEnabled !== false
    ) {
      try {
        await this.video.requestPictureInPicture();
        return;
      } catch (error) {
        if (errorName(error) !== 'NotSupportedError' || !this.webkitMiniSupported()) throw error;
      }
    }
    if (this.webkitMiniSupported()) {
      this.video.webkitSetPresentationMode?.('picture-in-picture');
      return;
    }
    throw new DOMException('Browser picture in picture is unavailable.', 'NotSupportedError');
  }

  syncNativeMini() {
    const native = Boolean(this.nativeMiniMode());
    const changed = this.player.classList.contains('native-mini-player') !== native;
    this.player.classList.toggle('native-mini-player', native);
    this.player.classList.toggle('mini-player', native);
    setNativePictureInPicture(native);
    this.updateMini();
    if (changed)
      console.info(`[LayerGlass] Mini player ${native ? 'opened' : 'closed'}`, { mode: 'video-pip' });
  }

  async restoreMini() {
    const native = this.nativeMiniMode();
    if (native) {
      try {
        if (native === 'standard') await this.video.ownerDocument.exitPictureInPicture();
        else this.video.webkitSetPresentationMode?.('inline');
      } catch (error) {
        console.debug('[LayerGlass] Picture in picture could not close', errorName(error));
      }
    }
    this.syncNativeMini();
    this.chrome.show();
  }

  updateMini() {
    const active = this.fullscreen.miniActive();
    const videoSupported =
      !this.video.hidden &&
      this.video.readyState > 0 &&
      ((typeof this.video.requestPictureInPicture === 'function' &&
        this.video.ownerDocument.pictureInPictureEnabled !== false) ||
        this.webkitMiniSupported());
    for (const button of this.player.querySelectorAll<HTMLButtonElement>('[data-player-action="mini"]')) {
      button.setAttribute('aria-pressed', String(active));
      button.disabled = Boolean(this.miniOpening) || !(active || videoSupported);
    }
    this.fullscreen.update();
    this.stats.renderActivity();
  }

  showStats(open: boolean, options?: { focus?: boolean }) {
    const wasHidden = this.stats.hidden;
    this.stats.show(open, options);
    if (open && wasHidden) console.debug('[LayerGlass] Playback diagnostics opened');
    this.chrome.show();
  }
}
