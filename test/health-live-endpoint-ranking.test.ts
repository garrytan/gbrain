import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

// The helper executes the real getHealth SQL against in-memory PGLite, with
// non-SQL collaborators mocked in a child so no global mock leaks across tests.
test('#6940 hub degree counts only live in-scope far endpoints', () => {
  const child = spawnSync(process.execPath, ['run', join(import.meta.dir, 'helpers/health-live-endpoint-fixture.ts')], {
    env: {}, encoding: 'utf8', timeout: 30_000,
  });
  expect(child.error).toBeUndefined();
  expect(child.signal).toBeNull();
  expect(child.status, child.stderr + child.stdout).toBe(0);
  const result = JSON.parse(child.stdout.trim());
  expect(result.statements).toBe(45);
  expect(result.results).toHaveLength(15);
  expect(result.failures).toEqual([]);
}, 35_000);
