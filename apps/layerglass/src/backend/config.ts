import { isRecord, parseJson } from '../../../backend-contracts/src/index.js';
import type { BackendConfiguration } from '../../../backend-contracts/src/index.js';
// Configuration contains only the chosen transport and its public origin.
// Printer access codes remain on the Python server, never in this preference.
import { directOrigin } from './direct.js';
export const BACKEND_KEY = 'layerglass-backend';

export function backendConfig(
  value: unknown = {},
  page = globalThis.location?.href || 'http://localhost/',
): BackendConfiguration {
  if (!isRecord(value)) throw new TypeError('Invalid backend configuration.');
  if (value.type === 'demo') return { type: 'demo' };
  if (value.type === 'direct') {
    if (value.profile && value.profile !== 'moonraker')
      throw new TypeError('This direct printer profile is not approved.');
    return { type: 'direct', profile: 'moonraker', url: directOrigin(value.url, page) };
  }
  const current = new URL(page);
  const message = 'Use a backend hostname or HTTP(S) origin, without a path or credentials.';
  const rawAddress = value.url === undefined ? current.origin : value.url;
  let address: string;
  if (typeof rawAddress !== 'string' || !rawAddress.trim()) throw new TypeError(message);
  address = rawAddress.trim();
  if (address.includes('\\') || (address.startsWith('/') && !address.startsWith('//')))
    throw new TypeError(message);
  // A hostname (including a port or bracketed IPv6 address) defaults to HTTPS.
  // Leave explicit schemes intact so the origin validation can reject them.
  if (
    !/^(?:[a-z][a-z\d+.-]*:\/\/|(?:https?|file|ftp|ftps|ws|wss|javascript|data|blob|mailto|tel):)/i.test(
      address,
    )
  ) {
    address = address.startsWith('//') ? `https:${address}` : `https://${address}`;
  }
  let url;
  try {
    url = new URL(address);
  } catch (_) {
    throw new TypeError(message);
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new TypeError(message);
  }
  if (current.protocol === 'https:' && url.protocol === 'http:') url.protocol = 'https:';
  return { type: 'python', url: url.origin };
}

export function readBackend(
  storage?: Pick<Storage, 'getItem'>,
  page = globalThis.location?.href,
  declared = globalThis.document?.querySelector<HTMLMetaElement>('meta[name="layerglass-backend"]')?.content,
): BackendConfiguration | null {
  const query = new URL(page || 'http://localhost/').searchParams;
  if (query.get('backend') === 'demo') return { type: 'demo' };
  // Python-served HTML explicitly supplies its own backend. A standalone app
  // has none until the user chooses; a legacy demo marker is not consent.
  const fallback = declared === 'python' ? backendConfig({}, page) : null;
  try {
    storage ??= globalThis.localStorage;
    const saved = parseJson(storage?.getItem(BACKEND_KEY) || 'null');
    if (!isRecord(saved)) return fallback;
    if (
      saved.type !== 'demo' &&
      !(saved?.type === 'python' && typeof saved.url === 'string' && saved.url) &&
      !(
        saved?.type === 'direct' &&
        saved.profile === 'moonraker' &&
        typeof saved.url === 'string' &&
        saved.url
      )
    )
      return fallback;
    return backendConfig(saved, page);
  } catch (_) {
    return fallback;
  }
}

export function saveBackend(
  value: unknown,
  storage = globalThis.localStorage,
  page = globalThis.location?.href,
) {
  const config = backendConfig(value, page);
  storage.setItem(BACKEND_KEY, JSON.stringify(config));
  return config;
}
