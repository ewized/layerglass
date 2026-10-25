// Events use the same epoch-second clock as recorded printer samples. This
// model has no transport dependency: live SSE, browser providers and explicitly
// loaded history can all supply the same session-scoped telemetry batches.
const ACTIVE = new Set(['PREPARE', 'RUNNING', 'PAUSE']);
const TERMINAL = new Set(['IDLE', 'FINISH', 'FAILED', 'CANCELLED']);
const LABELS = Object.freeze({ started: 'Print started', paused: 'Print paused', resumed: 'Print resumed',
  finished: 'Print finished', cancelled: 'Print cancelled', failed: 'Print failed',
  error: 'Printer error', job: 'Print job changed' });
const STATES = new Map([
  ['PREPARING', 'PREPARE'], ['PRINTING', 'RUNNING'], ['PAUSED', 'PAUSE'],
  ['FINISHED', 'FINISH'], ['COMPLETED', 'FINISH'], ['COMPLETE', 'FINISH'],
  ['CANCELED', 'CANCELLED'], ['ERROR', 'FAILED'],
]);
const own = (object, key) => Object.hasOwn(object, key);
const text = value => typeof value === 'string' && value.trim() ? value.trim().slice(0, 128) : null;

function reading(printer, previous) {
  const next = { ...previous };
  if (own(printer, 'print_state')) {
    const state = text(printer.print_state)?.toUpperCase();
    next.state = STATES.get(state) || (ACTIVE.has(state) || TERMINAL.has(state) ? state : null);
  }
  if (own(printer, 'job')) next.job = text(printer.job);
  const report = printer.reported?.print;
  if (report && typeof report === 'object') {
    for (const key of ['subtask_id', 'task_id']) {
      if (own(report, key)) next[key] = text(String(report[key] ?? ''))?.replace(/^0$/, '') || null;
    }
  }
  if (own(printer, 'error')) {
    const value = printer.error;
    next.error = (typeof value === 'number' && Number.isFinite(value) && value >= 0 ||
      typeof value === 'string' && /^\d+$/.test(value)) ? String(value) : null;
  }
  return next;
}

function differentJob(previous, next) {
  return ['subtask_id', 'task_id', 'job'].some(key => previous[key] && next[key] && previous[key] !== next[key]);
}

export class PrinterTimelineEvents {
  constructor({ maxEvents = 512, maxGap = 15 } = {}) {
    this.maxEvents = Math.max(1, maxEvents);
    this.maxGap = maxGap;
    this.events = [];
    this.session = null;
    this.last = null;
  }

  setSession(session) {
    if (session?.session_id === this.session?.session_id && session?.camera_id === this.session?.camera_id) return;
    this.session = session;
    this.events = [];
    this.last = null;
  }

  apply(payload) {
    if (!this.session || payload?.session_id !== this.session.session_id || payload.camera_id !== this.session.camera_id ||
        !Array.isArray(payload.samples) || !Number.isFinite(payload.from) || !Number.isFinite(payload.until) || payload.until < payload.from) return;
    const samples = payload.samples.filter(sample => Number.isFinite(sample?.at) && sample.printer &&
      typeof sample.printer === 'object' && !Array.isArray(sample.printer)).sort((a, b) => a.at - b.at);
    // An old explicitly fetched window can fill its own events. It cannot use
    // today's last reading as the previous state of a historical sample.
    let previous = samples[0]?.at >= this.last?.at ? this.last : null;
    const events = new Map(this.events.map(event => [event.id, event]));
    for (const sample of samples) {
      if (previous && sample.at < previous.at) continue;
      if (previous && sample.at === previous.at) {
        // A provider may enrich one instant with another partial report. Keep
        // new fields for the next sample, but a contradictory state/error at
        // the same instant cannot establish a chronological transition.
        const value = reading(sample.printer, previous.value);
        for (const key of ['state', 'error']) {
          if (previous.value[key] != null && value[key] != null && previous.value[key] !== value[key]) value[key] = null;
        }
        previous = { at: sample.at, value, connected: own(sample.printer, 'connection') ?
          sample.printer.connection === 'connected' : previous.connected };
        if (this.last?.at === sample.at) this.last = previous;
        continue;
      }
      const connected = !own(sample.printer, 'connection') || sample.printer.connection === 'connected';
      const contiguous = previous?.connected && connected && sample.at - previous.at <= this.maxGap;
      const value = reading(sample.printer, contiguous ? previous.value : {});
      const add = type => {
        const id = `${sample.at}:${type}`;
        events.set(id, { id, type, at: sample.at, label: LABELS[type] });
      };
      if (contiguous) {
        const before = previous.value;
        const changed = differentJob(before, value);
        if (TERMINAL.has(before.state) && ACTIVE.has(value.state)) add('started');
        else if (ACTIVE.has(before.state) && ACTIVE.has(value.state) && changed) add('job');
        else if (!changed && (before.state === 'RUNNING' || before.state === 'PREPARE') && value.state === 'PAUSE') add('paused');
        else if (!changed && before.state === 'PAUSE' && (value.state === 'RUNNING' || value.state === 'PREPARE')) add('resumed');
        else if (ACTIVE.has(before.state) && value.state === 'FINISH') add('finished');
        else if (ACTIVE.has(before.state) && value.state === 'CANCELLED') add('cancelled');
        else if (ACTIVE.has(before.state) && value.state === 'FAILED') add('failed');
        // FAILED already describes this observation. A nonzero code on the
        // first sample is a baseline, not evidence of a newly raised error.
        if (value.state !== 'FAILED' && value.error && !/^0+$/.test(value.error) &&
            before.error != null && value.error !== before.error) add('error');
      }
      previous = { at: sample.at, value, connected };
      if (!this.last || sample.at > this.last.at) this.last = previous;
    }
    this.events = [...events.values()].sort((a, b) => a.at - b.at || a.type.localeCompare(b.type)).slice(-this.maxEvents);
  }

  visible(session, { start = session?.start_seconds, end = session?.end_seconds } = {}) {
    if (!session || session.session_id !== this.session?.session_id || session.camera_id !== this.session?.camera_id) return [];
    const retainedTime = timelineTime(session, session.start_seconds);
    if (retainedTime != null) this.events = this.events.filter(event => event.at >= retainedTime);
    return this.events.flatMap(event => {
      const position = timelinePosition(session, event.at);
      return position != null && position >= start && position <= end ? [{ ...event, position }] : [];
    });
  }
}

export function timelineTime(session, position) {
  if (!Number.isFinite(position)) return null;
  const clock = session?.clock?.findLast(anchor => Number.isFinite(anchor.position) && Number.isFinite(anchor.time) && anchor.position <= position);
  return clock ? clock.time + position - clock.position : null;
}

export function timelinePosition(session, at) {
  if (!Number.isFinite(at)) return null;
  const clocks = (session?.clock || []).filter(anchor => Number.isFinite(anchor.position) && Number.isFinite(anchor.time));
  // Clock anchors preserve relay restart gaps. Never pin an event from a gap to
  // the next frame, or project a future event beyond the recorded media edge.
  for (let index = clocks.length - 1; index >= 0; index--) {
    const clock = clocks[index];
    const end = clocks[index + 1]?.position ?? session.end_seconds;
    const position = clock.position + (at - clock.time);
    const withinClock = at >= clock.time && (position < end || index === clocks.length - 1 && position === end);
    if (withinClock && position >= session.start_seconds && position <= session.end_seconds) return position;
  }
  return null;
}

// Collapse nearby markers into one accessible menu instead of covering the
// slider with overlapping touch targets. Event times themselves never change.
export function groupTimelineEvents(events, start, end, width, spacing = 32) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || width <= 0) return [];
  const groups = [];
  for (const event of events) {
    const fraction = Math.max(0, Math.min(1, (event.position - start) / (end - start)));
    const previous = groups.at(-1);
    if (previous && (fraction - previous.fraction) * width < spacing) previous.events.push(event);
    else groups.push({ fraction, events: [event] });
  }
  return groups;
}
