// Use the displayed slider window, which deliberately stays stable while
// scrubbing/paused, and clamp to actual retained footage rather than projected Live.
export function previewPoint({ min, max, start, end, left, width, x, value }) {
  if (![min, max, start, end].every(Number.isFinite) || max <= min || end <= start) return null;
  const fraction = value === undefined
    ? Math.max(0, Math.min(1, (x - left - 8) / Math.max(1, width - 16)))
    : Math.max(0, Math.min(1, (value - min) / (max - min)));
  const time = Math.max(start, Math.min(Math.max(start, end - 0.05), min + fraction * (max - min)));
  return { fraction, time };
}

// Backup endpoint: six five-second samples per sheet. An existing partial sheet
// remains useful as Live grows; captured browser frames take priority over it.
export function previewSheet({ time, start, end }) {
  if (![time, start, end].every(Number.isFinite) || start < 0 || end - start <= 0.05 || time < start || time >= end) return null;
  const bucket = Math.floor(time / 30) * 30;
  const first = Math.max(start, bucket);
  const count = Math.min(6, Math.floor((Math.min(end, bucket + 30) - first - 0.05) / 5) + 1);
  if (count < 1) return null;
  return { start: first, count, index: Math.min(count - 1, Math.floor((time - first) / 5)) };
}

export function previewLeft(fraction, trackWidth, cardWidth) {
  return Math.max(0, Math.min(Math.max(0, trackWidth - cardWidth),
    8 + fraction * Math.max(0, trackWidth - 16) - cardWidth / 2));
}
