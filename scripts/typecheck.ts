import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkTypeScriptOnly } from './check-typescript-only.ts';

await checkTypeScriptOnly(fileURLToPath(new URL('..', import.meta.url)));

for (const configuration of ['browser', 'service-worker', 'node', 'edge', 'tests']) {
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url)),
      '-p',
      `tsconfig.${configuration}.json`,
      '--pretty',
      'false',
    ],
    { stdio: 'inherit' },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
