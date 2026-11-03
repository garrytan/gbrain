/**
 * GBRA-135 L6: the keyed Tier 2 nightly fails when its tests did not all run.
 * A keyless or all-skip `bun test` exits 0, so scripts/require-executed-tests.ts
 * reads the run's receipts and refuses zero passes, any skip and any failure.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { load } from 'js-yaml';
import { executedProblems } from '../../scripts/require-executed-tests.ts';

const REPO = join(import.meta.dir, '../..');

function receiptsFor(body: string) {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-require-executed-'));
  mkdirSync(join(root, 'test'));
  writeFileSync(join(root, 'test/t2.test.ts'), `import { describe, test, expect } from 'bun:test';\n${body}`);
  const receipts = join(root, 'receipts');
  const run = spawnSync('bash', [join(REPO, 'scripts/run-with-receipt.sh'), 'tier2', 'skills', '--', 'bun', 'test', '--timeout=60000', join(root, 'test/t2.test.ts')], {
    cwd: REPO, encoding: 'utf8', env: { ...process.env, GBRAIN_NO_SNAPSHOT: '1', GBRAIN_TEST_RECEIPT_DIR: receipts },
  });
  return { root, receipts, run };
}

const guard = (dir: string, lane = 'tier2') =>
  spawnSync('bun', [join(REPO, 'scripts/require-executed-tests.ts'), dir, lane], { cwd: REPO, encoding: 'utf8' });

describe('require-executed-tests', () => {
  test('the keyless Tier 2 file skips everything with exit 0, and the guard fails it', () => {
    const receipts = mkdtempSync(join(tmpdir(), 'gbrain-require-executed-t2-'));
    try {
      const env: Record<string, string | undefined> = { ...process.env, GBRAIN_NO_SNAPSHOT: '1', GBRAIN_TEST_RECEIPT_DIR: receipts };
      delete env.GBRAIN_TEST_KEEP_PROVIDER_KEYS;
      delete env.DATABASE_URL;
      const run = spawnSync('bash', ['scripts/run-with-receipt.sh', 'tier2', 'skills', '--', 'bun', 'test', '--timeout=60000', 'test/e2e/skills.test.ts'], { cwd: REPO, encoding: 'utf8', env });
      expect(run.status, run.stdout + run.stderr).toBe(0);
      const g = guard(receipts);
      expect(g.status).toBe(1);
      expect(g.stderr).toContain('tier2 ran 0 tests');
      expect(g.stderr).toContain('skip: test/e2e/skills.test.ts > E2E Tier 2: Health Skill > health skill reports brain status');
    } finally { rmSync(receipts, { recursive: true, force: true }); }
  });

  test('passes only when at least one test ran and every test passed', () => {
    const { root, receipts, run } = receiptsFor(`describe('t2', () => { test('a', () => expect(1).toBe(1)); test('b', () => {}); });`);
    try {
      expect(run.status, run.stdout + run.stderr).toBe(0);
      expect(executedProblems(receipts, 'tier2')).toEqual([]);
      const g = guard(receipts);
      expect(g.status, g.stderr).toBe(0);
      expect(g.stdout).toContain('tier2: every test ran and passed');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('a partial skip fails even when other tests passed', () => {
    const { root, receipts } = receiptsFor(`describe('t2', () => { test('a', () => {}); test.skip('keyed', () => {}); });`);
    try {
      const problems = executedProblems(receipts, 'tier2');
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/^skip: .*t2\.test\.ts > t2 > keyed$/);
      expect(guard(receipts).status).toBe(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('a failed test, a missing receipt and another lane all fail', () => {
    const { root, receipts, run } = receiptsFor(`test('broken', () => expect(1).toBe(2));`);
    try {
      expect(run.status).not.toBe(0);
      expect(executedProblems(receipts, 'tier2')).toEqual(['tier2 ran 0 tests', expect.stringMatching(/^fail: .*t2\.test\.ts > broken$/)]);
      expect(executedProblems(receipts, 'tier1')).toEqual([`no tier1 receipt in ${receipts}: the test step did not run`]);
      expect(executedProblems(join(root, 'absent'), 'tier2')[0]).toContain('the test step did not run');
      expect(guard(join(root, 'absent')).status).toBe(1);
      expect(guard('').status).toBe(2);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('e2e.yml runs Tier 2 keyed and gates it on the guard', () => {
    type Step = { name?: string; run?: string; env?: Record<string, string>; if?: string };
    const tier2 = (load(readFileSync(join(REPO, '.github/workflows/e2e.yml'), 'utf8')) as { jobs: Record<string, { steps: Step[] }> }).jobs.tier2!;
    const names = tier2.steps.map(s => s.name);
    const run = tier2.steps.find(s => s.name === 'Run Tier 2 skill tests')!;
    expect(run.env!.GBRAIN_TEST_KEEP_PROVIDER_KEYS).toBe('1');
    expect(run.run).toContain('scripts/run-with-receipt.sh tier2 ');
    const check = tier2.steps.find(s => s.name === 'Require every Tier 2 test to run')!;
    expect(check.run).toBe('bun scripts/require-executed-tests.ts "$RUNNER_TEMP/receipts" tier2');
    expect(check.if).toBeUndefined();
    expect(names.indexOf('Require every Tier 2 test to run')).toBe(names.indexOf('Run Tier 2 skill tests') + 1);
    expect(tier2.steps.find(s => s.name === 'Provider-key coverage notice')!.env!.GBRAIN_TEST_KEEP_PROVIDER_KEYS).toBe('1');
  });

  test('a graduation shard with no database env skips everything and exits 0, and the guard fails it (#8003)', () => {
    const receipts = mkdtempSync(join(tmpdir(), 'gbrain-require-executed-grad-'));
    try {
      const env: Record<string, string | undefined> = { ...process.env, GBRAIN_NO_SNAPSHOT: '1', GBRAIN_TEST_RECEIPT_DIR: receipts, GBRAIN_TEST_RECEIPT_LANE: 'tier1', SHARD: '1/1' };
      delete env.DATABASE_URL;
      delete env.GBRAIN_PGBOUNCER_URL;
      const run = spawnSync('bash', ['scripts/run-e2e.sh', 'test/e2e/graduation-cli-history.test.ts'], { cwd: REPO, encoding: 'utf8', env });
      expect(run.status, run.stdout + run.stderr).toBe(0);
      const g = guard(receipts, 'tier1');
      expect(g.status).toBe(1);
      expect(g.stderr).toContain('tier1 ran 0 tests');
      expect(g.stderr).toContain('skip: test/e2e/graduation-cli-history.test.ts > graduation: 1k-page history round trip');
    } finally { rmSync(receipts, { recursive: true, force: true }); }
  });

  test('e2e.yml gates each graduation shard on the guard (#8003)', () => {
    type Step = { name?: string; run?: string; if?: string };
    const grad = (load(readFileSync(join(REPO, '.github/workflows/e2e.yml'), 'utf8')) as { jobs: Record<string, { steps: Step[] }> }).jobs['tier1-graduation']!;
    const names = grad.steps.map(s => s.name);
    const check = grad.steps.find(s => s.name === 'Require every graduation test to run')!;
    expect(check.run).toBe('bun scripts/require-executed-tests.ts "$RUNNER_TEMP/receipts" tier1');
    expect(check.if).toBeUndefined();
    expect(names.indexOf('Require every graduation test to run')).toBe(names.indexOf('Run engine graduation suites (direct Postgres and PgBouncer)') + 1);
  });
});
