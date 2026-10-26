import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { prepareDelivery, verifyDelivery, verifyPublished } from '../../../scripts/delivery.ts';

const source = 'a'.repeat(40);

async function fixture(t: TestContext) {
  const project = await mkdtemp(join(tmpdir(), 'layerglass-delivery-'));
  t.after(() => rm(project, { recursive: true, force: true }));
  const output = join(project, 'dist/apps');
  const files: Record<string, string> = {
    '.edge/layerglass.mjs': 'export default {};',
    'layerglass-site/index.html': '<h1>LayerGlass</h1>',
    'layerglass/index.html': '<main>Choose a backend</main>',
    'layerglass/static/bootstrap.js': 'export const bootstrap = true;',
    'layerglass/service-worker.js': 'const cacheEnabled = false;',
    'layerglass/_headers': '/*\n  Cache-Control: no-store\n',
  };
  for (const [path, bytes] of Object.entries(files)) {
    await mkdir(join(output, path, '..'), { recursive: true });
    await writeFile(join(output, path), bytes);
  }
  return { project, output, files };
}

test('the prepared artifact binds both complete builds to a full source revision', async (t) => {
  const { project, output } = await fixture(t);
  const first = await prepareDelivery(source, project);
  assert.equal(first.source, source);
  assert.equal(first.files.length, 6);
  assert.deepEqual(await verifyDelivery(source, project), first);
  assert.deepEqual(await prepareDelivery(source, project), first);
  assert.equal(JSON.parse(await readFile(join(output, 'deployment.json'), 'utf8')).source, source);
});

for (const change of ['changed', 'removed', 'extra']) {
  test(`artifact verification rejects ${change} assets after validation`, async (t) => {
    const { project, output } = await fixture(t);
    await prepareDelivery(source, project);
    if (change === 'removed') await rm(join(output, 'layerglass/static/bootstrap.js'));
    else
      await writeFile(
        join(output, change === 'extra' ? 'layerglass/extra.js' : 'layerglass/static/bootstrap.js'),
        'different',
      );
    await assert.rejects(verifyDelivery(source, project), /artifact differs/);
  });
}

test('another source revision or a changed manifest cannot promote an artifact', async (t) => {
  const { project, output } = await fixture(t);
  const manifest = await prepareDelivery(source, project);
  await assert.rejects(verifyDelivery('b'.repeat(40), project), /artifact differs/);
  manifest.files[0]!.path = '../../outside';
  await writeFile(join(output, 'deployment.json'), JSON.stringify(manifest));
  await assert.rejects(verifyDelivery(source, project), /artifact differs/);
});

test('packaging refuses a missing app, private configuration or a third build', async (t) => {
  const { project, output } = await fixture(t);
  await writeFile(join(output, 'layerglass/.env.local'), 'fixture-only');
  await assert.rejects(prepareDelivery(source, project), /private file/);
  await rm(join(output, 'layerglass/.env.local'));
  await mkdir(join(output, 'backend'));
  await assert.rejects(prepareDelivery(source, project), /only layerglass and layerglass-site/);
  await rm(join(output, 'backend'), { recursive: true });
  await rm(join(output, 'layerglass-site/index.html'));
  await assert.rejects(prepareDelivery(source, project), /both application entrypoints/);
});

test('asset and manifest symlinks cannot escape the deployment directory', async (t) => {
  const { project, output } = await fixture(t);
  const outside = join(project, 'outside.txt');
  await writeFile(outside, 'fixture-only');
  await symlink(outside, join(output, 'layerglass/link'));
  await assert.rejects(prepareDelivery(source, project), /symbolic link/);
  await rm(join(output, 'layerglass/link'));
  await symlink(outside, join(output, 'deployment.json'));
  await assert.rejects(prepareDelivery(source, project), /only layerglass and layerglass-site/);
  await assert.rejects(verifyDelivery(source, project), /only layerglass and layerglass-site/);
  assert.equal(await readFile(outside, 'utf8'), 'fixture-only');
});

test('a branch name or abbreviated revision cannot identify a production artifact', async (t) => {
  const { project } = await fixture(t);
  for (const bad of ['main', 'abc123', undefined]) {
    await assert.rejects(prepareDelivery(bad, project), /full Git commit/);
    await assert.rejects(verifyDelivery(bad, project), /full Git commit/);
  }
});

test('production verification compares actual entrypoint bytes with the CI artifact', async (t) => {
  const { project, files } = await fixture(t),
    requests: string[] = [];
  await prepareDelivery(source, project);
  const fetchImpl = async (url: URL, options?: RequestInit) => {
    requests.push(String(url));
    assert.equal(options?.redirect, 'error');
    assert.equal(options?.cache, 'no-store');
    const name = url.host === 'layer.glass' ? 'layerglass-site' : 'layerglass';
    const path = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    return new Response(files[`${name}/${path}`]);
  };
  await verifyPublished(source, { project, fetchImpl });
  assert.equal(requests.length, 4);
  await assert.rejects(
    verifyPublished(source, { project, fetchImpl: async () => new Response('stale build') }),
    /Published bytes differ/,
  );
  await assert.rejects(
    verifyPublished(source, { project, fetchImpl: async () => new Response('unavailable', { status: 503 }) }),
    /Published bytes differ/,
  );
});

test('a locally changed artifact is rejected before production endpoints are queried', async (t) => {
  const { project, output } = await fixture(t);
  await prepareDelivery(source, project);
  await writeFile(join(output, 'layerglass/index.html'), 'changed after CI');
  let calls = 0;
  await assert.rejects(
    verifyPublished(source, {
      project,
      fetchImpl: async () => {
        calls++;
        return new Response('unused');
      },
    }),
    /artifact differs/,
  );
  assert.equal(calls, 0);
});
