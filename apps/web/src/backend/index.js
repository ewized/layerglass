import { readBackend } from './config.js';
import { PythonBackend } from './python.js';
import { DemoBackend } from './demo.js';

export { backendConfig, readBackend, saveBackend } from './config.js';
export { PythonBackend } from './python.js';
export { DemoBackend } from './demo.js';

export const configuration = readBackend();
export const backend = configuration.type === 'demo' ? new DemoBackend() : new PythonBackend(configuration.url);
