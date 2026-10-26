const WINDOW = 120;

function preceding(samples, time) {
  let low = 0;
  let high = samples.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (samples[middle].at <= time) low = middle + 1;
    else high = middle;
  }
  return low ? samples[low - 1] : null;
}

function acceptedSamples(payload, session) {
  if (!session || payload?.session_id !== session.session_id || payload.camera_id !== session.camera_id ||
      !Array.isArray(payload.samples) || !Number.isFinite(payload.from) || !Number.isFinite(payload.until) || payload.until < payload.from) return null;
  return payload.samples.filter(sample => Number.isFinite(sample?.at) && sample.printer && typeof sample.printer === 'object')
    .sort((a, b) => a.at - b.at);
}

function latestRecorded(payload, samples) {
  // An empty future query can have a future from/until without any recording.
  // Only accepted sample timestamps inside its coverage prove recorder progress.
  return samples.reduce((latest, sample) => sample.at >= payload.from && sample.at <= payload.until ?
    Math.max(latest, sample.at) : latest, -Infinity);
}

export function printerPlaybackTime(video, hls, replay) {
  if (!replay.session) return null;
  if (!replay.remote && replay.session.kind !== 'jpeg') {
    const date = hls?.playingDate;
    if (date && Number.isFinite(date.getTime())) return date.getTime() / 1000;
    try {
      const start = video.getStartDate?.();
      if (start && Number.isFinite(start.getTime())) return start.getTime() / 1000 + video.currentTime;
    } catch (_) { /* Native HLS may not expose its program clock. */ }
  }
  const position = replay.paused ? replay.position : replay.bounds().current;
  const clocks = replay.session.clock || [];
  let anchor = null;
  for (const clock of clocks) {
    if (clock.position > position) break;
    anchor = clock;
  }
  if (!anchor) return null;
  const time = anchor.time + position - anchor.position;
  return replay.session.kind === 'jpeg' && Number.isFinite(replay.session.end_time) ?
    Math.min(time, replay.session.end_time) : time;
}

// Eight two-minute windows bound phone memory. Fresh readings arrive over the
// existing SSE connection; a distant explicit seek fetches one history window.
export class PrinterHistory {
  constructor(onChange = () => {}, { fetcher = (...args) => fetch(...args), maxWindows = 8, onSamples = () => {}, onSession = () => {} } = {}) {
    this.onChange = onChange;
    this.fetcher = fetcher;
    this.maxWindows = maxWindows;
    this.onSamples = onSamples;
    this.onSession = onSession;
    this.windows = new Map();
    this.session = null;
    this.version = 0;
    this.request = null;
    this.recordedUntil = -Infinity;
  }

  setSession(session) {
    if (session?.session_id === this.session?.session_id) return;
    this.version++;
    this.request?.cancel();
    this.request = null;
    this.controller = null;
    this.pending = null;
    this.windows.clear();
    this.recordedUntil = -Infinity;
    this.session = session;
    this.onSession(session);
    this.warned = false;
  }

  window(key) {
    let window = this.windows.get(key);
    if (!window) window = { samples: [], ranges: [], requested: false, partial: null };
    this.windows.delete(key);
    this.windows.set(key, window);
    while (this.windows.size > this.maxWindows) this.windows.delete(this.windows.keys().next().value);
    return window;
  }

  apply(payload, notify = true) {
    const samples = acceptedSamples(payload, this.session);
    if (!samples) return;
    this.recordedUntil = Math.max(this.recordedUntil, latestRecorded(payload, samples));
    for (let key = Math.floor(payload.from / WINDOW); key <= Math.floor(payload.until / WINDOW); key++) {
      const start = key * WINDOW;
      const end = start + WINDOW;
      const window = this.window(key);
      const baseline = preceding(samples, start);
      const incoming = samples.filter(sample => sample.at >= start && sample.at <= end);
      if (baseline) incoming.unshift(baseline);
      window.samples = [...new Map([...window.samples, ...incoming].map(sample => [sample.at, sample])).values()]
        .sort((a, b) => a.at - b.at);
      const ranges = [...window.ranges, [Math.max(start, payload.from), Math.min(end, payload.until)]]
        .sort((a, b) => a[0] - b[0]);
      window.ranges = [];
      for (const range of ranges) {
        const previous = window.ranges.at(-1);
        if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1]);
        else window.ranges.push([...range]);
      }
    }
    this.onSamples({ ...payload, samples });
    if (notify) this.onChange();
  }

  read(time) {
    if (!this.session || this.session.telemetry === false || !Number.isFinite(time)) return null;
    const key = Math.floor(time / WINDOW);
    const window = this.window(key);
    if (window.ranges.some(([start, end]) => start <= time && time <= end)) return preceding(window.samples, time)?.printer || null;
    const hydrate = window.partial && time > window.partial.until && time <= this.recordedUntil &&
      this.recordedUntil > window.partial.recorded;
    if (this.pending !== key && (!window.requested || hydrate) && globalThis.navigator?.onLine !== false) this.load(key, time, Boolean(hydrate));
    return null; // Missing history must never substitute today's live reading.
  }

  peek(time) {
    if (!this.session || !Number.isFinite(time)) return null;
    const window = this.windows.get(Math.floor(time / WINDOW));
    if (!window?.ranges.some(([start, end]) => start <= time && time <= end)) return null;
    return preceding(window.samples, time)?.printer || null;
  }

  retry() {
    for (const window of this.windows.values()) window.requested = false;
  }

  async load(key, time, hydrating = false) {
    this.request?.cancel();
    const controller = this.controller = new AbortController();
    const version = this.version;
    const session = this.session;
    const recorded = this.recordedUntil;
    this.pending = key;
    const window = this.window(key);
    window.requested = true;
    window.partial = null; // Consume eligibility before callbacks or more reads.
    let timedOut = false, finished = false, timeout;
    const request = this.request = { cancel: () => {
      clearTimeout(timeout);
      // Superseded reads may return to this window before the aborted fetch
      // settles. A real failure/timeout keeps its explicit-retry suppression.
      if (this.request === request && !finished && !timedOut && version === this.version &&
          this.windows.get(key) === window) window.requested = false;
      controller.abort();
    } };
    timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 6000);
    try {
      const response = await this.fetcher(`/api/sessions/${session.session_id}/printer?at=${encodeURIComponent(time)}`, {
        cache: 'no-store', signal: controller.signal,
      });
      if (!response.ok) throw new Error('Printer history unavailable');
      const payload = await response.json();
      if (version !== this.version || controller.signal.aborted) return;
      finished = true;
      const samples = acceptedSamples(payload, session);
      const until = samples && Math.min((key + 1) * WINDOW, payload.until);
      // A first partial success may become useful after recording advances. A
      // hydration that still misses its target must not rearm an identical
      // partial response on every render or subsequent SSE sample.
      if (samples && payload.from < (key + 1) * WINDOW && until >= key * WINDOW && until < (key + 1) * WINDOW &&
          (!hydrating || until >= time)) {
        window.partial = { until, recorded: Math.max(recorded, latestRecorded(payload, samples)) };
      }
      this.apply(payload);
    } catch (error) {
      if (version !== this.version || controller.signal.aborted && !timedOut) return;
      finished = true;
      if (!this.warned) console.warn('[LayerGlass] Recorded printer readings unavailable', error.name);
      this.warned = true;
    } finally {
      clearTimeout(timeout);
      if (this.request === request) {
        if (controller.signal.aborted) request.cancel();
        this.request = this.controller = this.pending = null;
      }
    }
  }
}
