/** Required nodes fail at the component boundary instead of much later in playback. */
export function required<E extends Element = HTMLElement>(root: ParentNode, selector: string): E {
  const element =
    /^#[\w-]+$/.test(selector) && 'getElementById' in root && typeof root.getElementById === 'function'
      ? (root.getElementById(selector.slice(1)) as E | null)
      : root.querySelector<E>(selector);
  if (!element) throw new Error(`Missing player element: ${selector}`);
  return element;
}
export function eventElement(event: Event): Element {
  const target = event.target;
  if (!target || !('closest' in target) || typeof target.closest !== 'function')
    throw new TypeError('Expected an element event target');
  return target as Element;
}

export interface PlayerElements {
  viewer: HTMLElementTagNameMap['printer-camera-view'];
  'pull-refresh': HTMLElementTagNameMap['printer-pull-indicator'];
  'camera-name': HTMLElement;
  'camera-id': HTMLElement;
  'player-options': HTMLElementTagNameMap['printer-settings'];
  'video-context-menu': HTMLElementTagNameMap['printer-context-menu'];
  'player-stats': HTMLElementTagNameMap['printer-stats'];
  'player-controls': HTMLElementTagNameMap['printer-controls'];
  'video-diffusion': HTMLElement;
  video: HTMLVideoElement;
  jpeg: HTMLImageElement;
  overlay: HTMLElementTagNameMap['printer-loading'];
  'caption-label': HTMLElement;
  loader: HTMLElement;
  'offline-icon': SVGSVGElement;
  'overlay-title': HTMLElement;
  'overlay-subtitle': HTMLElement;
  'play-button': HTMLButtonElement;
  'empty-scan-button': HTMLButtonElement;
  'settings-back': HTMLButtonElement;
  'settings-title': HTMLElement;
  'scan-button': HTMLButtonElement;
  'scan-label': HTMLElement;
  'printers-button': HTMLButtonElement;
  'selected-printer': HTMLElement;
  'backends-button': HTMLButtonElement;
  'selected-backend': HTMLElement;
  'refresh-button': HTMLButtonElement;
  'refresh-label': HTMLElement;
  'stream-message': HTMLElement;
  'printer-skeleton': HTMLElement;
  'camera-list': HTMLElementTagNameMap['printer-list'];
  'discovery-message': HTMLElement;
  'backend-list': HTMLElementTagNameMap['printer-backend-list'];
  'local-media-label': HTMLLabelElement;
  'local-media': HTMLInputElement;
  'backend-form': HTMLFormElement;
  'backend-url-label': HTMLLabelElement;
  'backend-url': HTMLInputElement;
  'backend-confirm': HTMLButtonElement;
  'backend-error': HTMLElement;
  'backend-capabilities': HTMLElement;
  'close-stats': HTMLButtonElement;
  'stats-values': HTMLElement;
  'pull-refresh-label': HTMLElement;
  'replay-controls': HTMLElement;
  'timeline-events': HTMLElementTagNameMap['printer-timeline-events'];
  'replay-slider': HTMLInputElement;
  'scrub-preview': HTMLElementTagNameMap['printer-scrub-preview'];
  'replay-detail': HTMLElement;
  'player-toolbar': HTMLElement;
  'pause-button': HTMLButtonElement;
  'live-button': HTMLButtonElement;
  'replay-time': HTMLElement;
  'status-pill': HTMLElement;
  'status-label': HTMLElement;
  'options-button': HTMLButtonElement;
  'cast-button': HTMLButtonElement;
  'fullscreen-button': HTMLButtonElement;
  'i-settings': HTMLElement;
  'i-printer': HTMLElement;
  'i-chevron': HTMLElement;
  'i-back': HTMLElement;
  'i-close': HTMLElement;
  'i-refresh': HTMLElement;
  'i-key': HTMLElement;
  'i-trash': HTMLElement;
  'i-connection': HTMLElement;
  'i-offline': HTMLElement;
  'i-restart': HTMLElement;
  'i-mini': HTMLElement;
  'i-cast': HTMLElement;
  'i-stats': HTMLElement;
  'i-copy': HTMLElement;
  'i-check': HTMLElement;
  'i-search': HTMLElement;
  'i-play': HTMLElement;
  'i-pause': HTMLElement;
  'i-restore': HTMLElement;
  'i-fullscreen': HTMLElement;
  'i-exit-fullscreen': HTMLElement;
  'backend-picker': HTMLElementTagNameMap['printer-backend-picker'];
  player: HTMLElementTagNameMap['printer-player'];
}

export function playerElement<K extends keyof PlayerElements>(root: ParentNode, id: K): PlayerElements[K] {
  return required<PlayerElements[K]>(root, `#${id}`);
}
