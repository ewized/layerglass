// Integration against Wrangler's local asset engine, not a handwritten server.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { prepare, verify } from '../../../scripts/cloudflare.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
for (const [index, name] of ['layerglass-site', 'layerglass'].entries()) {
  await prepare(name);
  const port = 8789 + index;
  const origin = `http://127.0.0.1:${port}`;
  let output = '';
  let startupError;
  const child = spawn(
    join(root, 'infra/cloudflare/node_modules/.bin/wrangler'),
    [
      'dev',
      '--config',
      join(root, 'infra/cloudflare', `${name}.wrangler.json`),
      '--local',
      '--ip',
      '127.0.0.1',
      '--port',
      String(port),
      '--inspector-port',
      '0',
    ],
    {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CI: 'true',
        WRANGLER_SEND_METRICS: 'false',
        XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME || join(tmpdir(), 'layerglass-cloudflare-local'),
      },
    },
  );
  child.on('error', (error) => {
    startupError = error;
  });
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (data) => {
      output = (output + data).slice(-12000);
    });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 150; attempt++) {
      if (startupError) throw startupError;
      if (child.exitCode !== null) throw new Error(`Local ${name} exited: ${output}`);
      try {
        const response = await fetch(origin, { signal: AbortSignal.timeout(1000) });
        await response.arrayBuffer();
        if (response.ok) {
          ready = true;
          break;
        }
      } catch {
        /* Asset engine has not bound the port yet. */
      }
      await delay(100);
    }
    assert.ok(ready, `Local ${name} did not become ready: ${output}`);
    await verify(name, { origin });
    if (name === 'layerglass') {
      const response = await fetch(`${origin}/demo-backend/src/demo/printer.mp4`, {
        headers: { Range: 'bytes=0-127', 'Accept-Encoding': 'identity' },
      });
      // Miniflare's asset worker returns the complete body for Range requests.
      // The public CDN can serve 206 at its outer cache layer; do not pretend
      // local 200 responses prove edge range behavior.
      assert.ok([200, 206].includes(response.status));
      const source = await readFile(join(root, 'dist/apps/layerglass/demo-backend/src/demo/printer.mp4'));
      assert.deepEqual(
        Buffer.from(await response.arrayBuffer()),
        response.status === 206 ? source.subarray(0, 128) : source,
      );
      if (response.status === 206)
        assert.match(response.headers.get('content-range') || '', /^bytes 0-127\//);
      assert.match(response.headers.get('content-type') || '', /video\/mp4/);
      console.info(`Local demo media: ${response.status}, correct MP4 body`);
    }
    console.info(`Local Cloudflare assets: ${name} headers, MIME and 404 routing passed`);
  } finally {
    if (child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }
  }
}
