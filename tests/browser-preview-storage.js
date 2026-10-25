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
      const results = [];
      for (let i = 0; i < 5; i++) results.push(await disk.put({ session: 'storage-test', key: 'frame:' + i,
        blob: new Blob([new Uint8Array(300).fill(i)], { type: 'image/jpeg' }) }));
      const old = await disk.get('storage-test', 'frame:0');
      const latest = await disk.get('storage-test', 'frame:4');
      const other = await disk.get('another-page', 'frame:4');
      await disk.removeSession('storage-test');
      const closed = await disk.get('storage-test', 'frame:4');
      return { opened: Boolean(db), available, failures, writes: results, maxBytes: disk.maxBytes,
        oldestEvicted: !old, latest: latest && new Uint8Array(await latest.blob.arrayBuffer())[0],
        anotherPageHidden: !other, closed: !closed };
    });
    console.log(JSON.stringify({ browser: name, ...result }));
    assert.equal(result.opened, true);
    assert.equal(result.available, true);
    assert.deepEqual(result.failures, []);
    assert(result.writes.every(Boolean));
    assert.equal(result.oldestEvicted, true);
    assert.equal(result.latest, 4);
    assert(result.anotherPageHidden && result.closed);
  } finally { await browser.close(); }
}
