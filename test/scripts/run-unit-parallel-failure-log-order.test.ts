/**
 * The failure log must hold each failing test's OWN context/error/diff.
 * Bun prints those lines ABOVE the `(fail)` line, so the extractor in
 * scripts/run-unit-parallel.sh must collect lines preceding the marker.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync, chmodSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');
let ROOT: string;
let log = '';

beforeAll(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'gbrain-failure-order-'));
  mkdirSync(join(ROOT, 'scripts', 'lib'), { recursive: true });
  mkdirSync(join(ROOT, 'test'), { recursive: true });
  for (const f of ['lib/test-env.sh', 'run-unit-parallel.sh', 'run-unit-shard.sh', 'sharding.ts', 'run-serial-tests.sh']) {
    copyFileSync(join(REPO_ROOT, 'scripts', f), join(ROOT, 'scripts', f));
  }
  for (const f of ['run-unit-parallel.sh', 'run-unit-shard.sh', 'run-serial-tests.sh']) chmodSync(join(ROOT, 'scripts', f), 0o755);
  writeFileSync(join(ROOT, 'test', 'order.test.ts'), `import { test, expect } from 'bun:test';
test('first fails', () => { expect('AAA-actual').toBe('AAA-expected'); });
test('second passes', () => { expect(1).toBe(1); });
test('third fails', () => { expect('CCC-actual').toBe('CCC-expected'); });
`);
  spawnSync('bash', [join(ROOT, 'scripts', 'run-unit-parallel.sh'), '--shards', '1'], {
    cwd: ROOT,
    stdio: 'ignore', // no inherited pipe: a leaked heartbeat child must not block the read
    env: { ...process.env, GBRAIN_TEST_NO_MEM_ADAPT: '1', GBRAIN_TEST_NO_OOM_FALLBACK: '1' },
  });
  const p = join(ROOT, '.context', 'test-failures.log');
  log = existsSync(p) ? readFileSync(p, 'utf-8') : '';
}, 120_000);

afterAll(() => {
  if (ROOT) rmSync(ROOT, { recursive: true, force: true });
});

describe('run-unit-parallel.sh failure log block ownership', () => {
  it('each block holds its own diff, not the next test\'s', () => {
    const first = log.indexOf('--- shard 1: (fail) first fails');
    const third = log.indexOf('--- shard 1: (fail) third fails');
    expect(first).toBeGreaterThan(-1);
    expect(third).toBeGreaterThan(first);
    const firstBlock = log.slice(0, first);
    const thirdBlock = log.slice(first, third + 1000);
    expect(firstBlock).toContain('Expected: "AAA-expected"');
    expect(firstBlock).toContain('Received: "AAA-actual"');
    expect(firstBlock).not.toContain('CCC-expected');
    expect(thirdBlock).toContain('Expected: "CCC-expected"');
    expect(thirdBlock).toContain('Received: "CCC-actual"');
  });
});
