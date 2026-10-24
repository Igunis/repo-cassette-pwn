import { spawnSync } from 'node:child_process';

const result = spawnSync('node', ['unicode_mime_probe.mjs'], {
  stdio: 'inherit',
  env: process.env,
});
process.exit(result.status ?? 1);
