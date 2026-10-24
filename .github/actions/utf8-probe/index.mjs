import { spawnSync } from 'node:child_process';

const result = spawnSync('python3', ['invalid_utf8_mime_probe.py'], {
  stdio: 'inherit',
  env: process.env,
});
process.exit(result.status ?? 1);
