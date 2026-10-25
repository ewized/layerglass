import { PlayerElement } from './base.js';
import { PageReplay } from '../replay.js';
import { groupTimelineEvents } from '../timeline-events.js';

export class PrinterTimelineMarkers extends PlayerElement {
  connectedCallback() {
    super.connectedCallback();
    this.setAttribute('role', 'group');
    this.setAttribute('aria-label', 'Print events');
    this.listen(this, 'click', event => this.activate(event));
    this.listen(this, 'keydown', event => this.keydown(event));
    this.listen(this, 'pointerover', event => this.describe(event.target.closest('.timeline-event')));
    this.listen(this, 'focusin', event => this.describe(event.target.closest('.timeline-event')));
    this.listen(this, 'pointerleave', () => this.hideTooltip());
    this.listen(this, 'focusout', event => { if (!this.contains(event.relatedTarget)) this.closeMenu(); });
    this.listen(this.ownerDocument, 'pointerdown', event => { if (!this.contains(event.target)) this.closeMenu(); }, { capture: true });
    this.observer?.disconnect();
    this.observer = new ResizeObserver(() => this.render());
    this.observer.observe(this);
    this.render();
  }

  configure(readReplay, history) {
    this.readReplay = readReplay;
    this.history = history;
    this.render();
  }

  offset(event) {
    const replay = this.readReplay?.();
    return `−${PageReplay.time(Math.max(0, (replay?.timeline.edge ?? replay?.session?.end_seconds ?? event.position) - event.position))}`;
  }

  render() {
    if (!this.isConnected || !this.rendered) return;
    const replay = this.readReplay?.();
    const slider = this.parentElement?.querySelector('#replay-slider');
    const session = replay?.session;
    const groups = !session || !this.history || slider?.disabled ? [] : groupTimelineEvents(
      this.history.visible(session, { start: Number(slider.min), end: Number(slider.max) }),
      Number(slider.min), Number(slider.max), this.clientWidth);
    const signature = groups.map(group => group.events.map(event => event.id).join(',')).join('|');
    if (signature !== this.signature) {
      const focused = this.querySelector('.timeline-event:focus') ||
        (this.menu?.contains(this.ownerDocument.activeElement) ? this.opener : null);
      const focusedId = this.groups?.[Number(focused?.dataset.group)]?.events[0]?.id;
      const focusIndex = Math.max(0, groups.findIndex(group => group.events.some(event => event.id === focusedId)));
      this.reset();
      this.signature = signature;
      this.groups = groups;
      for (const [index, group] of groups.entries()) {
        const button = this.ownerDocument.createElement('button');
        button.type = 'button';
        button.className = `timeline-event event-${group.events.at(-1).type}`;
        button.dataset.group = String(index);
        button.tabIndex = index === focusIndex ? 0 : -1;
        if (group.events.length > 1) { button.setAttribute('aria-haspopup', 'menu'); button.setAttribute('aria-expanded', 'false'); }
        this.append(button);
      }
      const tooltip = this.ownerDocument.createElement('span');
      tooltip.className = 'timeline-event-tooltip';
      tooltip.hidden = true;
      this.append(tooltip);
      this.tooltip = tooltip;
      if (focused) this.querySelector('.timeline-event[tabindex="0"]')?.focus({ preventScroll: true });
    }
    this.groups = groups;
    for (const button of this.querySelectorAll('.timeline-event')) {
      const group = groups[Number(button.dataset.group)];
      button.style.left = `${group.fraction * 100}%`;
      const first = group.events[0];
      button.setAttribute('aria-label', group.events.length > 1 ? `${group.events.length} print events, ${this.offset(first)} from live` : `${first.label}, ${this.offset(first)} from live`);
    }
    const described = this.querySelector('.timeline-event:is(:hover, :focus-visible)');
    if (described && !this.menu) this.describe(described);
    for (const button of this.menu?.querySelectorAll('button') || []) {
      const event = this.menuEvents[Number(button.dataset.event)];
      button.querySelector('time').textContent = this.offset(event);
    }
  }

  describe(button) {
    if (!this.tooltip || !button || this.menu) return;
    const group = this.groups[Number(button.dataset.group)];
    if (!group) return;
    this.tooltip.replaceChildren();
    const label = this.ownerDocument.createElement('span');
    label.textContent = group.events.length > 1 ? `${group.events.length} print events` : group.events[0].label;
    const time = this.ownerDocument.createElement('time');
    time.textContent = this.offset(group.events[0]);
    this.tooltip.append(label, time);
    this.tooltip.style.left = `clamp(86px, ${group.fraction * 100}%, calc(100% - 86px))`;
    this.tooltip.hidden = false;
  }

  hideTooltip() { if (this.tooltip) this.tooltip.hidden = true; }

  activate(event) {
    const item = event.target.closest('[data-event]');
    if (item) { this.seek(this.menuEvents?.[Number(item.dataset.event)]); return; }
    const button = event.target.closest('.timeline-event');
    const group = button && this.groups?.[Number(button.dataset.group)];
    if (!group) return;
    if (group.events.length === 1) { this.seek(group.events[0]); return; }
    if (this.opener === button && this.menu) { this.closeMenu(); return; }
    this.closeMenu();
    this.hideTooltip();
    this.opener = button;
    button.setAttribute('aria-expanded', 'true');
    const menu = this.ownerDocument.createElement('div');
    menu.className = 'timeline-event-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'Print events');
    menu.style.left = `clamp(106px, ${group.fraction * 100}%, calc(100% - 106px))`;
    this.menuEvents = group.events;
    for (const [index, value] of group.events.entries()) {
      const choice = this.ownerDocument.createElement('button');
      choice.type = 'button'; choice.tabIndex = -1; choice.dataset.event = String(index);
      choice.setAttribute('role', 'menuitem');
      const label = this.ownerDocument.createElement('span'); label.textContent = value.label;
      const time = this.ownerDocument.createElement('time'); time.textContent = this.offset(value);
      choice.append(label, time); menu.append(choice);
    }
    this.append(menu); this.menu = menu;
    menu.firstElementChild?.focus({ preventScroll: true });
  }

  seek(event) {
    const replay = this.readReplay?.();
    const slider = this.parentElement?.querySelector('#replay-slider');
    if (!event || slider?.disabled || !replay?.session || !this.history.visible(replay.session).some(value => value.id === event.id)) return;
    replay.seek(event.position);
    this.closeMenu();
    // Fitting the timeline for this seek can regroup/recreate markers. Restore
    // focus by event identity rather than holding a detached menu opener.
    const group = this.groups.findIndex(value => value.events.some(value => value.id === event.id));
    const button = this.querySelector(`.timeline-event[data-group="${group}"]`);
    if (button) {
      for (const marker of this.querySelectorAll('.timeline-event')) marker.tabIndex = marker === button ? 0 : -1;
      button.focus({ preventScroll: true });
    }
    this.emit('timeline-event-seek', { id: event.id, position: event.position });
  }

  keydown(event) {
    const inMenu = event.target.closest('.timeline-event-menu');
    const buttons = [...this.querySelectorAll(inMenu ? '.timeline-event-menu button' : '.timeline-event')];
    if (event.key === 'Escape') { this.closeMenu(true); event.preventDefault(); return; }
    const previous = inMenu ? 'ArrowUp' : 'ArrowLeft';
    const next = inMenu ? 'ArrowDown' : 'ArrowRight';
    if (![previous, next, 'Home', 'End'].includes(event.key)) return;
    const current = buttons.indexOf(event.target);
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 :
      (current + (event.key === previous ? -1 : 1) + buttons.length) % buttons.length;
    if (!inMenu) for (const button of buttons) button.tabIndex = button === buttons[index] ? 0 : -1;
    buttons[index]?.focus({ preventScroll: true });
    event.preventDefault(); event.stopPropagation();
  }

  closeMenu(restoreFocus = false) {
    const opener = this.opener;
    const menu = this.menu;
    // Removing a focused child can synchronously emit focusout. Clear our
    // references first so its dismissal handler cannot remove the same node.
    this.menu = null; this.menuEvents = null; this.opener = null;
    menu?.remove();
    opener?.setAttribute('aria-expanded', 'false');
    this.hideTooltip();
    if (restoreFocus) opener?.focus({ preventScroll: true });
  }

  reset() {
    this.closeMenu();
    this.replaceChildren();
    this.groups = []; this.signature = null; this.tooltip = null;
  }

  disconnectedCallback() {
    this.observer?.disconnect();
    this.closeMenu();
    super.disconnectedCallback();
  }
}
