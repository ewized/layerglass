// Session-scoped JPEG bytes, independent of the PWA/app-shell cache. There is
// no permission prompt: storage is best effort, and playback never waits for it.
export class PreviewStorage {
  constructor({ factory = globalThis.indexedDB, ranges = globalThis.IDBKeyRange,
    storage = globalThis.navigator?.storage, maxBytes = 128 * 1024 * 1024, maxRecords = 20000 } = {}) {
    Object.assign(this, { factory, ranges, storage, maxBytes, maxRecords });
    this.available = Boolean(factory && ranges);
    this.ready = null;
    this.readers = new Set();
    this.generation = 0;
  }

  fail(error) {
    if (this.available && !this.warned) console.warn('[LayerGlass] Local preview storage unavailable; keeping previews in memory', error?.name);
    this.warned = true;
    this.available = false;
  }

  open() {
    if (!this.available) return Promise.resolve(null);
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      const request = this.factory.open('printer-camera-previews', 1);
      const timer = setTimeout(() => reject(new DOMException('Preview storage blocked', 'TimeoutError')), 2000);
      request.onupgradeneeded = () => {
        const db = request.result;
        const frames = db.createObjectStore('images', { keyPath: ['session', 'key'] });
        frames.createIndex('session', 'session');
        frames.createIndex('created', 'created');
        db.createObjectStore('metadata');
      };
      request.onerror = () => { clearTimeout(timer); reject(request.error); };
      request.onsuccess = () => {
        clearTimeout(timer);
        const db = request.result;
        if (!this.available) { db.close(); resolve(null); return; }
        db.onversionchange = () => { db.close(); this.ready = null; };
        db.onclose = () => { this.ready = null; };
        resolve(db);
        // Expire abandoned pages even if pagehide could not finish its cleanup.
        this.removeWhere({ before: Date.now() - 24 * 60 * 60 * 1000 });
      };
    }).catch(error => { this.fail(error); return null; });
    this.storage?.estimate?.().then(({ quota, usage }) => {
      if (Number.isFinite(quota) && Number.isFinite(usage)) this.maxBytes = Math.min(this.maxBytes,
        Math.max(0, Math.floor((quota - usage) * 0.1)));
    }).catch(() => {});
    return this.ready;
  }

  async put(record) {
    const generation = this.generation;
    if (!this.available || this.suspended || record.blob.size > this.maxBytes) return false;
    try {
      // Store compressed binary data rather than file-backed Blobs. This avoids
      // WebKit's "Error preparing Blob/File data" path without base64 inflation.
      // Finish conversion BEFORE opening the transaction (Safari auto-commits).
      // Read immediately, too: waiting for IndexedDB to open can leave WebKit
      // reading a page-owned Blob after navigation has already started.
      const { blob, ...fields } = record;
      const data = await this.readBytes(blob);
      const db = await this.open();
      if (!db || !this.available || blob.size > this.maxBytes) return false;
      if (this.suspended || generation !== this.generation) return false;
      await new Promise((resolve, reject) => {
        const tx = db.transaction(['images', 'metadata'], 'readwrite');
        const images = tx.objectStore('images');
        const metadata = tx.objectStore('metadata');
        tx.oncomplete = resolve;
        tx.onabort = () => reject(tx.error || new Error('Preview write aborted'));
        const previous = images.get([record.session, record.key]);
        previous.onsuccess = () => {
          const state = metadata.get('usage');
          state.onsuccess = () => {
            const usage = state.result || { bytes: 0, count: 0 };
            usage.bytes += record.blob.size - (previous.result?.size || 0);
            if (!previous.result) usage.count++;
            images.put({ ...fields, data, type: blob.type, size: blob.size, created: Date.now() });
            const cursor = images.index('created').openCursor();
            cursor.onsuccess = () => {
              const entry = cursor.result;
              if (!entry || usage.bytes <= this.maxBytes && usage.count <= this.maxRecords) {
                metadata.put(usage, 'usage');
                return;
              }
              if (entry.value.session !== record.session || entry.value.key !== record.key) {
                usage.bytes -= entry.value.size;
                usage.count--;
                entry.delete();
              }
              entry.continue();
            };
          };
        };
      });
      return true;
    } catch (error) {
      if (generation === this.generation) this.fail(error);
      return false;
    }
  }

  readBytes(blob) {
    if (typeof FileReader !== 'function') return blob.arrayBuffer();
    // FileReader can be aborted at pagehide. WebKit can otherwise report a
    // Blob.arrayBuffer() read as a failed blob URL load while the page unloads.
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      this.readers.add(reader);
      const finish = callback => { this.readers.delete(reader); callback(); };
      reader.onload = () => finish(() => resolve(reader.result));
      reader.onerror = () => finish(() => reject(reader.error));
      reader.onabort = () => finish(() => reject(new DOMException('Preview read cancelled', 'AbortError')));
      try { reader.readAsArrayBuffer(blob); }
      catch (error) { finish(() => reject(error)); }
    });
  }

  suspend() {
    this.suspended = true;
    this.generation++;
    for (const reader of this.readers) reader.abort();
  }

  resume() { this.suspended = false; }

  async get(session, key) {
    const db = await this.open();
    if (!db || !this.available) return null;
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction('images');
        const request = tx.objectStore('images').get([session, key]);
        tx.oncomplete = () => {
          const row = request.result;
          resolve(row ? { ...row, blob: row.blob || new Blob([row.data], { type: row.type || 'image/jpeg' }) } : null);
        };
        tx.onabort = () => reject(tx.error);
      });
    } catch (error) { this.fail(error); return null; }
  }

  async removeWhere({ session, key, before } = {}) {
    const db = await this.open();
    if (!db) return;
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(['images', 'metadata'], 'readwrite');
        const images = tx.objectStore('images');
        const metadata = tx.objectStore('metadata');
        tx.oncomplete = resolve;
        tx.onabort = () => reject(tx.error);
        const state = metadata.get('usage');
        state.onsuccess = () => {
          const usage = state.result || { bytes: 0, count: 0 };
          // Use indexed ranges: removing one evicted JPEG must not read every
          // other JPEG in a long print, and startup need only visit expired rows.
          const request = key !== undefined ? images.openCursor(this.ranges.only([session, key])) :
            session ? images.index('session').openCursor(this.ranges.only(session)) :
              images.index('created').openCursor(this.ranges.upperBound(before, true));
          request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) { metadata.put(usage, 'usage'); return; }
            usage.bytes = Math.max(0, usage.bytes - cursor.value.size);
            usage.count = Math.max(0, usage.count - 1);
            cursor.delete();
            cursor.continue();
          };
        };
      });
    } catch (_) { /* Storage eviction/closing must never interrupt playback. */ }
  }

  removeSession(session) { return this.removeWhere({ session }); }
  remove(session, key) { return this.removeWhere({ session, key }); }
}
