import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Representative, fixture-only regressions. Hardware checks remain opt-in.
const available = [
  'browser-esm.ts',
  'browser-components.ts',
  'browser-keyboard-focus.ts',
  'browser-backends.ts',
  'browser-backend-origin.ts',
  'browser-direct.ts',
  'browser-video-stream.ts',
  'browser-stream-recovery.ts',
  'browser-replay-recovery.ts',
  'browser-replay-suspension.ts',
  'browser-jpeg-clock.ts',
  'browser-preview-storage.ts',
  'browser-preview-buffer.ts',
  'browser-preview-loading.ts',
  'browser-scrub-commit.ts',
  'browser-timeline-events.ts',
  'browser-fullscreen.ts',
  'browser-google-cast.ts',
  'browser-history-reconnect.ts',
  'browser-pwa.ts',
];
const selected = process.argv.slice(2);
const suites = selected.length ? selected : available;
if (suites.some((suite) => !available.includes(suite))) {
  console.error('Choose browser suites from:', available.join(', '));
  process.exit(2);
}

for (const suite of suites) {
  console.log(`\nRunning ${suite}`);
  const result = spawnSync(process.execPath, [fileURLToPath(new URL(suite, import.meta.url))], {
    stdio: 'inherit',
    env: process.env,
    timeout: 240_000,
  });
  if (result.error || result.status !== 0) {
    console.error(`${suite} failed`, result.error || result.signal || result.status);
    process.exit(result.status || 1);
  }
}
console.log(`\nPassed ${suites.length} browser suites.`);
