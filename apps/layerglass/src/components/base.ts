import { LitElement, html, noChange, unsafeHTML } from '../platform.js';
import { required } from '../dom.js';
import { playerStyles } from '../styles.js';

/** Lit owns initial template rendering; controllers preserve the native media nodes. */
export class PlayerElement extends LitElement {
  static template = '';
  protected rendered = false;
  protected listeners = new AbortController();
  private adopted = false;

  protected override createRenderRoot() {
    return this;
  }

  override connectedCallback() {
    playerStyles(this.ownerDocument);
    this.adopted ||= this.hasAttribute('data-ssr');
    super.connectedCallback();
    // Existing controller setup reads children synchronously during upgrade.
    // The template has no dynamic parts, so later updates retain media/focus.
    if (!this.rendered) {
      if (!this.adopted) this.replaceChildren();
      this.performUpdate();
      this.rendered = true;
    }
    this.listeners.abort();
    this.listeners = new AbortController();
  }

  protected override render() {
    if (this.adopted) return noChange;
    const constructor = this.constructor as typeof PlayerElement;
    // Only repository-owned static templates reach this boundary.
    return html`${unsafeHTML(constructor.template)}`;
  }

  override disconnectedCallback() {
    this.listeners.abort();
    super.disconnectedCallback();
  }
  connectedMoveCallback() {}

  protected listen<K extends keyof GlobalEventHandlersEventMap>(
    target: EventTarget,
    type: K,
    listener: (event: GlobalEventHandlersEventMap[K]) => void,
    options?: AddEventListenerOptions,
  ): void;
  protected listen(
    target: EventTarget,
    type: string,
    listener: (event: CustomEvent<unknown>) => void,
    options?: AddEventListenerOptions,
  ): void;
  protected listen(
    target: EventTarget,
    type: string,
    listener: (event: never) => void,
    options: AddEventListenerOptions = {},
  ) {
    target.addEventListener(type, listener as EventListener, { ...options, signal: this.listeners.signal });
  }

  protected required<E extends Element = HTMLElement>(selector: string): E {
    return required<E>(this, selector);
  }

  protected emit<T>(type: string, detail?: T) {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }
}
