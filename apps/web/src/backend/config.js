// Configuration contains only the chosen transport and its public origin.
// Printer access codes remain on the Python server, never in this preference.
import { directOrigin } from './direct.js';
export const BACKEND_KEY = 'layerglass-backend';

export function backendConfig(value = {}, page = globalThis.location?.href || 'http://localhost/') {
  if (value.type === 'demo') return { type: 'demo' };
  if (value.type === 'direct') {
    if (value.profile && value.profile !== 'moonraker') throw new TypeError('This direct printer profile is not approved.');
    return { type: 'direct', profile: 'moonraker', url: directOrigin(value.url, page) };
  }
  const current = new URL(page);
  const url = new URL(value.url || current.origin);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) {
    throw new TypeError('Use a backend origin, such as https://printer.example.com, without a path or credentials.');
  }
  if (current.protocol === 'https:' && url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new TypeError('An HTTPS app needs an HTTPS backend. Open the local viewer directly or configure HTTPS on the backend.');
  }
  return { type: 'python', url: url.origin };
}

export function readBackend(storage, page = globalThis.location?.href,
  declared = globalThis.document?.querySelector('meta[name="layerglass-backend"]')?.content) {
  const query = new URL(page || 'http://localhost/').searchParams;
  if (query.get('backend') === 'demo') return { type: 'demo' };
  // Python-served HTML explicitly supplies its own backend. A standalone app
  // has none until the user chooses; a legacy demo marker is not consent.
  const fallback = declared === 'python' ? backendConfig({}, page) : null;
  try {
    storage ??= globalThis.localStorage;
    const saved = JSON.parse(storage?.getItem(BACKEND_KEY) || 'null');
    if (saved?.type !== 'demo' && !(saved?.type === 'python' && typeof saved.url === 'string' && saved.url) &&
        !(saved?.type === 'direct' && saved.profile === 'moonraker' && typeof saved.url === 'string' && saved.url)) return fallback;
    return backendConfig(saved, page);
  }
  catch (_) { return fallback; }
}

export function saveBackend(value, storage = globalThis.localStorage, page = globalThis.location?.href) {
  const config = backendConfig(value, page);
  storage.setItem(BACKEND_KEY, JSON.stringify(config));
  return config;
}
