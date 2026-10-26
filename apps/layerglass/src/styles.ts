import { createEmotion } from './platform.js';
import { playerTheme } from './theme.js';

const caches = new WeakMap<Document, ReturnType<typeof createEmotion>>();
/** One cache per document, reused across custom-element upgrades and moves. */
export function playerStyles(document: Document) {
  const existing = caches.get(document);
  if (existing) return existing;
  const instance = createEmotion({ key: 'layerglass', container: document.head });
  // The build extracts these exact global rules into a CSP-safe stylesheet.
  // Hydration records their IDs without inserting duplicate inline style tags.
  const ids = document.querySelector<HTMLMetaElement>('meta[name="layerglass-emotion"]')?.content;
  if (ids) instance.hydrate(ids.split(' ').filter(Boolean));
  instance.injectGlobal(playerTheme);
  caches.set(document, instance);
  return instance;
}
