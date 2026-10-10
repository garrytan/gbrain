import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Compiled CLI installations must ship the current provider and canonical skills.
test('embedded Hermes assets match the provider and canonical skillpack', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const result = spawnSync(process.execPath, ['scripts/generate-hermes-assets.ts', '--check'], {
    cwd: root, encoding: 'utf8',
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
});
