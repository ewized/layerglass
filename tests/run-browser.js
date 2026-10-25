import { spawnSync } from 'node:child_process';

// Representative, fixture-only regressions. Hardware checks remain opt-in.
const available = [
  'browser-esm.js',
  'browser-components.js',
  'browser-video-stream.js',
  'browser-stream-recovery.js',
  'browser-preview-storage.js',
  'browser-preview-buffer.js',
  'browser-scrub-commit.js',
  'browser-fullscreen.js',
  'browser-google-cast.js',
  'browser-pwa.js',
];
const selected = process.argv.slice(2);
const suites = selected.length ? selected : available;
if (suites.some(suite => !available.includes(suite))) {
  console.error('Choose browser suites from:', available.join(', '));
  process.exit(2);
}

for (const suite of suites) {
  console.log(`\nRunning ${suite}`);
  const result = spawnSync(process.execPath, [new URL(suite, import.meta.url).pathname], {
    stdio: 'inherit', env: process.env, timeout: 240_000,
  });
  if (result.error || result.status !== 0) {
    console.error(`${suite} failed`, result.error || result.signal || result.status);
    process.exit(result.status || 1);
  }
}
console.log(`\nPassed ${suites.length} browser suites.`);
