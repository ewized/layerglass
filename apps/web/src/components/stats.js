import { PlayerElement } from './base.js';
import { statsTemplate } from './templates.js';
import { printerPlaybackTime } from '../printer-history.js';
import { printerStatRows } from '../printer-stats.js';

export class PrinterStats extends PlayerElement {
  static template = statsTemplate;
  static observedAttributes = ['hidden'];
  cells = new Map();
  timer = null;
  previousFrames = null;

  connectedCallback() {
    super.connectedCallback();
    this.values = this.querySelector('#stats-values');
    this.listen(this.querySelector('#close-stats'), 'click', () => this.show(false));
    this.listen(this.ownerDocument.defaultView, 'pagehide', () => this.stopUpdates());
    this.listen(this.ownerDocument.defaultView, 'pageshow', () => this.startUpdates());
    this.listen(this.ownerDocument.defaultView, 'replaypositionchange', () => {
      this.readState?.().printerHistory?.retry();
      this.renderStats();
    });
    const video = this.closest('printer-player')?.querySelector('video');
    if (video) this.listen(video, 'seeked', () => {
      this.readState?.().printerHistory?.retry();
      this.renderStats();
    });
    this.listen(this.ownerDocument, 'visibilitychange', () => {
      if (this.ownerDocument.hidden) this.stopUpdates();
      else this.startUpdates();
    });
    this.startUpdates();
  }

  configure({ readState, video, image, player }) {
    Object.assign(this, { readState, video, image, player });
    this.startUpdates();
  }

  attributeChangedCallback() {
    if (this.hidden) this.stopUpdates();
    else this.startUpdates();
  }

  disconnectedCallback() {
    this.stopUpdates();
    super.disconnectedCallback();
  }

  show(open) {
    const changed = this.hidden === open;
    this.hidden = !open;
    if (changed) this.emit('stats-change', { open });
  }

  startUpdates() {
    if (this.timer !== null || !this.values || !this.readState || !this.isConnected || this.hidden || this.ownerDocument.hidden) return;
    this.previousFrames = null;
    this.readState().printerHistory?.retry();
    this.renderStats();
    this.timer = setInterval(() => this.renderStats(), 1000);
  }

  stopUpdates() {
    clearInterval(this.timer);
    this.timer = null;
    this.previousFrames = null;
  }

  renderStats() {
    if (!this.readState || !this.isConnected || this.hidden || this.ownerDocument.hidden) return;
    const { camera, printer: currentPrinter, server, printerHistory, discovery, replay, hls, videoStream, videoCodec } = this.readState();
    const printer = printerHistory && replay.session ?
      printerHistory.read(printerPlaybackTime(this.video, hls, replay)) : currentPrinter;
    const video = this.video;
    const jpeg = !this.image.hidden;
    const quality = video.getVideoPlaybackQuality?.();
    const frames = quality?.totalVideoFrames ?? video.webkitDecodedFrameCount;
    const dropped = quality?.droppedVideoFrames ?? video.webkitDroppedFrameCount;
    const now = performance.now();
    const fps = !jpeg && Number.isFinite(frames) && this.previousFrames && now > this.previousFrames.at ?
      ((frames - this.previousFrames.count) * 1000 / (now - this.previousFrames.at)).toFixed(1) : null;
    this.previousFrames = Number.isFinite(frames) ? { count: frames, at: now } : null;
    let ahead = 0;
    for (let i = 0; i < video.buffered.length; i++) {
      if (video.currentTime >= video.buffered.start(i) && video.currentTime <= video.buffered.end(i)) ahead = video.buffered.end(i) - video.currentTime;
    }
    const width = jpeg ? this.image.naturalWidth : video.videoWidth;
    const height = jpeg ? this.image.naturalHeight : video.videoHeight;
    const bounds = replay.bounds();
    const position = replay.paused ? replay.position : bounds.current;
    const behind = Math.max(0, (replay.timeline.edge ?? bounds.end) - position);
    const bandwidth = videoStream ? null : hls?.bandwidthEstimate;
    let printerRows = printerStatRows(camera, printer);
    const context = `${camera?.id ?? camera?.host}:${replay.session?.session_id ?? ''}`;
    if (this.printerContext !== context) this.printerSchema = null;
    this.printerContext = context;
    if (printer) this.printerSchema = printerRows.map(([label, , key]) => [label, null, key]);
    else if (this.printerSchema) {
      // Keep known rows still while an uncached seek loads its historical
      // values. Never fill that gap with the current live printer reading.
      const metadata = new Map(printerRows.map(row => [row[2], row]));
      printerRows = this.printerSchema.map(row => metadata.get(row[2]) ?? row);
    }
    const videoRows = [
      ['Resolution', width && height ? `${width} × ${height}` : null],
      ['Viewport', `${Math.round(this.player.clientWidth)} × ${Math.round(this.player.clientHeight)}`],
      ['Frames / dropped', !jpeg && Number.isFinite(frames) ? `${frames} / ${dropped ?? '—'}` : null],
      ['Frame rate', fps === null ? null : `${fps} fps`],
      ['Decoder', jpeg ? 'Browser JPEG' : 'Browser native'],
      ['Media pipeline', jpeg ? 'Image' : hls ? 'hls.js + MediaSource' : replay.session?.kind === 'file' ? 'Native video' : 'Native HLS'],
      ['Video codec', jpeg ? 'JPEG' : videoCodec],
      ['Video delivery', jpeg ? server?.live_only ? 'MJPEG stream' : 'JPEG frames' : videoStream ?
        (videoStream.connected ? 'HTTP stream' : 'Reconnecting') : replay.session?.kind === 'file' ? 'Browser media' : 'HLS'],
      ['Video buffer', jpeg ? null : `${ahead.toFixed(1)} s`],
      ['Recorded history', replay.session ? `${Math.max(0, bounds.end - bounds.start).toFixed(1)} s` : null],
      ['Live offset', replay.session ? `−${behind.toFixed(1)} s` : null],
      ['Bandwidth estimate', Number.isFinite(bandwidth) && bandwidth > 0 ? `${Math.round(bandwidth / 1000)} kbps` : null],
      ['Media bit rate', videoStream?.mediaBitrate ? `${Math.round(videoStream.mediaBitrate / 1000)} kbps` : null],
    ];
    this.renderRows('video', videoRows);
    this.renderRows('printer', printerRows);
    this.renderActivity(discovery);
  }

  renderActivity(discovery) {
    if (!this.readState || !this.isConnected || this.hidden || this.ownerDocument.hidden) return;
    discovery ??= this.readState().discovery;
    const percent = discovery?.total ? Math.max(0, Math.min(100, Math.floor(100 * discovery.checked / discovery.total))) : null;
    this.renderRows('activity', [
      ['Printer scan', discovery?.state === 'scanning' ? `Scanning${percent === null ? '' : ` · ${percent}%`}${discovery.cached > 0 ? ` · ${discovery.cached} cached` : ''}` : null],
      ['Mini player', this.player.classList.contains('mini-player') ? 'Active' : null],
    ]);
  }

  renderRows(group, rows) {
    const list = this.values.querySelector(`[data-stats-section="${group}"]`);
    if (group === 'activity') rows = rows.filter(([, value]) => value !== null);
    const keys = new Set(rows.map(([label, , key = label]) => key));
    for (const cell of list.querySelectorAll('dd')) {
      if (keys.has(cell.dataset.statKey)) continue;
      cell.previousElementSibling.remove();
      cell.remove();
      this.cells.delete(`${group}:${cell.dataset.statKey}`);
    }
    let next = list.firstElementChild;
    for (const [label, value, key = label] of rows) {
      const id = `${group}:${key}`;
      let cell = this.cells.get(id);
      if (!cell) {
        const term = this.ownerDocument.createElement('dt');
        term.textContent = label;
        term.title = key;
        cell = this.ownerDocument.createElement('dd');
        cell.dataset.stat = label;
        cell.dataset.statKey = key;
        list.append(term, cell);
        this.cells.set(id, cell);
      }
      const term = cell.previousElementSibling;
      if (term !== next) {
        list.insertBefore(term, next);
        list.insertBefore(cell, next);
      }
      next = cell.nextElementSibling;
      const content = String(value ?? '—');
      if (cell.textContent !== content) cell.textContent = content;
    }
    if (group === 'activity') list.parentElement.hidden = !list.childElementCount;
  }
}
