// Light DOM keeps native media, labels, focus, and the shared player theme together.
export class PlayerElement extends HTMLElement {
  connectedCallback() {
    if (!this.rendered) {
      this.rendered = true;
      this.innerHTML = this.constructor.template || '';
    }
    this.listeners?.abort();
    this.listeners = new AbortController();
  }

  disconnectedCallback() { this.listeners?.abort(); }

  // Native moves can preserve focus and drafts without reconnecting the element.
  connectedMoveCallback() {}

  listen(target, type, listener, options = {}) {
    target.addEventListener(type, listener, { ...options, signal: this.listeners.signal });
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }
}
