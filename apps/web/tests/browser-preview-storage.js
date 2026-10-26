import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';

for (const [name, engine] of Object.entries({ webkit, chromium })) {
  const browser = await engine.launch({ headless: true, args: name === 'chromium' ? ['--no-sandbox'] : [] });
  const page = await browser.newPage({ serviceWorkers: 'block' });
  page.on('console', message => { if (message.type() === 'warning' && message.text().includes('preview storage')) console.log(name, message.text()); });
  try {
    await page.goto(process.env.VIEWER_URL || 'http://127.0.0.1:8080');
    const result = await page.evaluate(async () => {
      const { PreviewStorage } = await import('/static/preview-storage.js');
      const disk = new PreviewStorage({ maxBytes: 1000, maxRecords: 3 });
      const failures = [];
      const fail = disk.fail.bind(disk);
      disk.fail = error => { failures.push({ name: error?.name, message: error?.message }); fail(error); };
      const db = await disk.open();
      const available = disk.available;
      const interrupted = disk.put({ session: 'storage-test', key: 'interrupted', blob: new Blob([new Uint8Array(300)]) });
      await new Promise(resolve => queueMicrotask(resolve));
      disk.suspend();
      const cancelled = await interrupted === false;
      disk.resume();
      const results = [];
      for (let i = 0; i < 5; i++) results.push(await disk.put({ session: 'storage-test', key: 'frame:' + i,
        blob: new Blob([new Uint8Array(300).fill(i)], { type: 'image/jpeg' }) }));
      const old = await disk.get('storage-test', 'frame:0');
      const latest = await disk.get('storage-test', 'frame:4');
      const other = await disk.get('another-page', 'frame:4');
      await disk.removeSession('storage-test');
      const closed = await disk.get('storage-test', 'frame:4');
const owned = 'owned-storage-test';
      const record = (owner, value) => ({ session: owned, key: 'same', owner,
        blob: new Blob([new Uint8Array(100).fill(value)], { type: 'image/jpeg' }) });
      await disk.put(record('old', 1));
      await disk.put(record('new', 2));
      await disk.remove(owned, 'same', 'old');
      const protectedRow = await disk.get(owned, 'same');
      const conditionalDelete = protectedRow?.owner === 'new' &&
        new Uint8Array(await protectedRow.blob.arrayBuffer())[0] === 2;
      let release, firstRead = true, current = true;
      const readBytes = disk.readBytes.bind(disk);
      disk.readBytes = async blob => {
        const bytes = await readBytes(blob);
        if (firstRead) { firstRead = false; await new Promise(resolve => release = resolve); }
        return bytes;
      };
      const late = disk.put(record('retired', 3), { current: () => current });
      while (!release) await new Promise(resolve => setTimeout(resolve, 0));
      await disk.put(record('latest', 4));
      current = false; release();
      const staleWriteSkipped = await late === false;
      const latestOwned = await disk.get(owned, 'same');
      disk.readBytes = readBytes;

      // Queue the real transaction behind an active IDB transaction. A guard
      // checked only before transaction creation would wrongly admit this write.
      const transaction = db.transaction.bind(db);
      const blocker = transaction(['images', 'metadata'], 'readwrite');
      let blocked = true, queued = false, queuedCurrent = true;
      const keepAlive = () => {
        const request = blocker.objectStore('images').get([owned, 'same']);
        request.onsuccess = () => { if (blocked) keepAlive(); };
      };
      keepAlive();
      db.transaction = (...args) => { const tx = transaction(...args); queued = true; return tx; };
      const queuedWrite = disk.put(record('queued-retired', 5), { current: () => queuedCurrent });
      const deadline = performance.now() + 3000;
      while (!queued) {
        if (performance.now() > deadline) throw Error('Real IDB mutation was not queued');
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      queuedCurrent = false; blocked = false;
      const queuedWriteSkipped = await queuedWrite === false;
      db.transaction = transaction;
      const afterQueue = await disk.get(owned, 'same');
      const usageCorrect = await new Promise((resolve, reject) => {
        const tx = transaction(['images', 'metadata']);
        const rows = tx.objectStore('images').getAll(), usage = tx.objectStore('metadata').get('usage');
        tx.onabort = () => reject(tx.error);
        tx.oncomplete = () => resolve(usage.result.bytes === rows.result.reduce((sum, row) => sum + row.size, 0) &&
          usage.result.count === rows.result.length);
      });
      await disk.remove(owned, 'same', 'latest');
      const ownedCleanup = !await disk.get(owned, 'same');
      await disk.put(record('legacy-api', 6));
      await disk.remove(owned, 'same');
      const legacyCleanup = !await disk.get(owned, 'same');
      await disk.put(record('failed-old', 7));
      const oversized = { ...record('failed-new', 8), blob: new Blob([new Uint8Array(2000)]) };
      const failedReplacement = await disk.put(oversized) === false;
      await disk.remove(owned, 'same', 'failed-old');
      const failedHasNoOldPixels = !await disk.get(owned, 'same');
      let repeatedOwned = true;
      await disk.put({ ...record('other-key', 9), key: 'other' });
      for (let index = 0; index < 20; index++) {
        await disk.put(record('repeat-' + index, index));
        await disk.remove(owned, 'same', 'repeat-' + (index - 1));
        repeatedOwned &&= (await disk.get(owned, 'same'))?.owner === 'repeat-' + index;
      }
      const otherKeySurvives = (await disk.get(owned, 'other'))?.owner === 'other-key';
      await disk.removeSession(owned);
      const sessionCleanup = !await disk.get(owned, 'same') && !await disk.get(owned, 'other');
      return { opened: Boolean(db), available, cancelled, resumed: disk.available, failures, writes: results, maxBytes: disk.maxBytes,
        oldestEvicted: !old, latest: latest && new Uint8Array(await latest.blob.arrayBuffer())[0],
        anotherPageHidden: !other, closed: !closed, conditionalDelete, staleWriteSkipped, queuedWriteSkipped,
        latestOwner: latestOwned?.owner, queuedOwner: afterQueue?.owner, usageCorrect, ownedCleanup, legacyCleanup,
        failedReplacement, failedHasNoOldPixels, repeatedOwned, otherKeySurvives, sessionCleanup };
    });
    console.log(JSON.stringify({ browser: name, ...result }));
    assert.equal(result.opened, true);
    assert.equal(result.available, true);
    assert.equal(result.cancelled, true);
    assert.equal(result.resumed, true);
    assert.deepEqual(result.failures, []);
    assert(result.writes.every(Boolean));
    assert.equal(result.oldestEvicted, true);
    assert.equal(result.latest, 4);
    assert(result.anotherPageHidden && result.closed);
    assert(result.conditionalDelete, 'A retired asset cannot delete a newer owned row');
    assert(result.staleWriteSkipped, 'A retired conversion cannot overwrite a replacement');
    assert(result.queuedWriteSkipped, 'Ownership must be rechecked inside the queued IDB mutation');
    assert.equal(result.latestOwner, 'latest'); assert.equal(result.queuedOwner, 'latest');
    assert(result.usageCorrect && result.ownedCleanup && result.legacyCleanup);
    assert(result.failedReplacement && result.failedHasNoOldPixels && result.repeatedOwned && result.otherKeySurvives && result.sessionCleanup);
  } finally { await browser.close(); }
}
