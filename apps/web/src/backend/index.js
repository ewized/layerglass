import { backendConfig, readBackend } from './config.js';
import { PythonBackend } from './python.js';
import { DemoBackend } from './demo.js';
import { DirectPrinterBackend } from './direct.js';

export { backendConfig, readBackend, saveBackend } from './config.js';
export { PythonBackend } from './python.js';
export { DemoBackend } from './demo.js';
export { DirectPrinterBackend, probeDirectPrinter, directBrowserError } from './direct.js';

const createBackend = config => config.type === 'demo' ? new DemoBackend() : config.type === 'direct' ?
  new DirectPrinterBackend(config.url, { profile: config.profile }) : new PythonBackend(config.url);
export let configuration = readBackend();
export let backend = configuration ? createBackend(configuration) : null;

// Startup activates only an explicit choice (or the Python host's own backend).
// Keep a page-local choice usable when browser storage is unavailable.
export function activateBackend(value) {
  configuration = backendConfig(value);
  backend = createBackend(configuration);
}
