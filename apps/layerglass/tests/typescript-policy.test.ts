import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkTypeScriptOnly } from '../../../scripts/check-typescript-only.ts';

test('the source policy rejects every authored JavaScript extension without a Git index', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'layerglass-source-policy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'tests'));
  for (const extension of ['js', 'mjs', 'cjs', 'jsx']) {
    const file = join(root, 'tests', `fixture.${extension}`);
    await writeFile(file, '');
    await assert.rejects(
      checkTypeScriptOnly(root),
      (error: unknown) => error instanceof Error && error.message.includes(`tests/fixture.${extension}`),
    );
    await rm(file);
  }
});

test('the source policy permits TypeScript and ignores generated code and installed dependencies', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'layerglass-source-policy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'source.ts'), '');
  for (const directory of ['node_modules', 'dist', '.git', '.nx', 'test-results']) {
    await mkdir(join(root, directory));
    await writeFile(join(root, directory, 'generated.js'), '');
  }
  await checkTypeScriptOnly(root);
});
