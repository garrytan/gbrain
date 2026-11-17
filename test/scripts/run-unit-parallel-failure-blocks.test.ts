/**
 * #9315: each block in .context/test-failures.log holds its own failing
 * test's context, error and Expected/Received diff. Bun prints those lines
 * above the test's `(fail)` line, so a block that starts at the marker held
 * the next test's context and the last failure's block was empty.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');
let root = '';
let log = '';

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'gbrain-failure-blocks-'));
  mkdirSync(join(root, 'scripts', 'lib'), { recursive: true });
  mkdirSync(join(root, 'test'), { recursive: true });
  for (const f of ['lib/test-env.sh', 'run-unit-parallel.sh', 'run-unit-shard.sh', 'run-serial-tests.sh', 'sharding.ts']) {
    copyFileSync(join(REPO_ROOT, 'scripts', f), join(root, 'scripts', f));
  }
  for (const f of ['run-unit-parallel.sh', 'run-unit-shard.sh', 'run-serial-tests.sh']) chmodSync(join(root, 'scripts', f), 0o755);
  writeFileSync(join(root, 'test', 'order.test.ts'), [
    "import { test, expect } from 'bun:test';",
    "test('first fails', () => { expect('AAA-actual').toBe('AAA-expected'); });",
    "test('second passes', () => { expect(1).toBe(1); });",
    "test('third fails', () => { expect('CCC-actual').toBe('CCC-expected'); });",
    '',
  ].join('\n'));
  spawnSync('bash', [join(root, 'scripts', 'run-unit-parallel.sh'), '--shards', '1'], {
    cwd: root,
    stdio: 'ignore',
    env: { ...process.env, GBRAIN_TEST_NO_MEM_ADAPT: '1', GBRAIN_TEST_NO_OOM_FALLBACK: '1' },
  });
  const path = join(root, '.context', 'test-failures.log');
  log = existsSync(path) ? readFileSync(path, 'utf-8') : '';
}, 120_000);

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

test('each failure block carries its own diff, ending at its own (fail) line', () => {
  const first = log.indexOf('--- shard 1: (fail) first fails');
  const third = log.indexOf('--- shard 1: (fail) third fails');
  expect(first).toBeGreaterThan(-1);
  expect(third).toBeGreaterThan(first);
  const firstBlock = log.slice(0, first);
  const thirdBlock = log.slice(first, third);
  expect(firstBlock).toContain('Expected: "AAA-expected"');
  expect(firstBlock).not.toContain('Expected: "CCC-expected"');
  expect(thirdBlock).toContain('Expected: "CCC-expected"');
  expect(thirdBlock).not.toContain('Expected: "AAA-expected"');
});
