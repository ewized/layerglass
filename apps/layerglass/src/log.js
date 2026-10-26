export const PlayerLog = {
  states: new Map(),
  changed(level, topic, details) {
    const signature = JSON.stringify(details);
    if (this.states.get(topic) === signature) return;
    this.states.set(topic, signature);
    console[level](`[LayerGlass] ${topic}`, details);
  },
  discovery(discovery, requested = false) {
    this.scans ??= new Map();
    const key = discovery.scan_id || 'current';
    const finished = ['done', 'error'].includes(discovery.state);
    let run = this.scans.get(key);
    if (key === 'current' && run?.finished && discovery.state === 'scanning') run = null;
    if (!run && (discovery.state === 'scanning' || (requested && finished))) {
      run = { finished: false };
      this.scans.set(key, run);
      console.info('[LayerGlass] Printer scan started');
    }
    if (run && !run.finished && finished) {
      run.finished = true;
      console[discovery.state === 'error' ? 'warn' : 'info']('[LayerGlass] Printer scan finished', {
        result: discovery.state === 'error' ? 'Failed' : 'Completed',
      });
    }
    if (this.scans.size > 32) this.scans.delete(this.scans.keys().next().value);
  },
};
