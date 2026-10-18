/**
 * test/postgres-unit-arms.txt is the one list persistence-validation's
 * unit-postgres-arms job, the race hunt and the lane guard read. Its shards
 * must cover every row exactly once, and the weight miner must read the
 * job's per-file group timestamps.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ARM_SHARD_BUDGET_MS, ARM_SHARDS, ARM_STEP_TIMEOUT_MS, ARM_WEIGHTS, mineArmWeights, parseArmsList, readArmsList } from '../../scripts/postgres-unit-arms.ts';
import { computeQuantile, loadWeights, partition } from '../../scripts/sharding.ts';

const REPO = join(import.meta.dir, '..', '..');
const cli = (...args: string[]) => spawnSync(process.execPath, [join(REPO, 'scripts', 'postgres-unit-arms.ts'), ...args], { encoding: 'utf8', cwd: REPO });

describe('postgres-unit-arms list', () => {
  test('the committed list parses cleanly', () => {
    const list = readArmsList(REPO);
    expect(list.errors).toEqual([]);
    expect(list.files.length).toBeGreaterThan(50);
  });

  test('the two CI shards cover every listed file exactly once', () => {
    const all = cli('list').stdout.trim().split('\n');
    const shards = [1, 2].map(n => cli('shard', String(n), '2').stdout.trim().split('\n'));
    expect([...shards[0]!, ...shards[1]!].sort()).toEqual([...all].sort());
    expect(shards[0]!.filter(f => shards[1]!.includes(f))).toEqual([]);
    expect(shards.every(s => s.length > 0)).toBe(true);
  });

  test('the workflow runs ARM_SHARDS shards inside the ARM_STEP_TIMEOUT_MS step timeout', () => {
    const workflow = readFileSync(join(REPO, '.github', 'workflows', 'persistence-validation.yml'), 'utf8');
    const job = workflow.slice(workflow.indexOf('  unit-postgres-arms:'), workflow.indexOf('\n  invariants:'));
    const shards = Array.from({ length: ARM_SHARDS }, (_, i) => i + 1);
    expect(job).toContain(`shard: [${shards.join(', ')}]`);
    expect(job).toContain(`Unit-lane PostgreSQL arms \${{ matrix.shard }}/${ARM_SHARDS}`);
    expect(job).toContain(`postgres-unit-arms.ts shard "$SHARD" ${ARM_SHARDS})`);
    expect(job).toContain(`shard $SHARD/${ARM_SHARDS} selected no files`);
    expect(job).toContain(`postgres-unit-arms.ts shard $SHARD ${ARM_SHARDS}' locally`);
    expect(job).toMatch(new RegExp(`- name: Require PostgreSQL arms of unit-lane suites\\n\\s+timeout-minutes: ${ARM_STEP_TIMEOUT_MS / 60_000}\\n`));
  });

  test('every CI shard\'s measured weight fits the step twice over, with a minute to spare', () => {
    const files = readArmsList(REPO).files;
    const weights = loadWeights(join(REPO, ARM_WEIGHTS));
    const p75 = computeQuantile(files.filter(f => weights.has(f)).map(f => weights.get(f)!), 0.75);
    const sums = partition(files, weights, ARM_SHARDS).map(shard => shard.reduce((ms, f) => ms + (weights.get(f) ?? p75), 0));
    expect(2 * ARM_SHARD_BUDGET_MS + 60_000).toBe(ARM_STEP_TIMEOUT_MS);
    expect(sums.filter(ms => ms > ARM_SHARD_BUDGET_MS)).toEqual([]);
  });

  test('ci:ubicloud\'s pg-arms lane runs each file with the workflow step\'s own command', () => {
    const command = 'bun --no-env-file test --timeout=120000';
    const workflow = readFileSync(join(REPO, '.github', 'workflows', 'persistence-validation.yml'), 'utf8');
    const item = readFileSync(join(REPO, 'scripts', 'ubicloud', 'ci-item.sh'), 'utf8');
    const lane = item.slice(item.indexOf('    pg-arms)'), item.indexOf(';;', item.indexOf('    pg-arms)')));
    expect(workflow).toContain(command);
    expect(lane).toContain(`${command} "$1"`);
    expect(lane).toContain('GBRAIN_TEST_ALLOW_DATABASE_URL=1');
    expect(lane).toContain('-u GBRAIN_TEST_TIMEOUT_MULTIPLIER');
  });

  test('comments and blank lines are ignored; a new path is a one-line edit', () => {
    expect(parseArmsList('# header\n\ntest/a.test.ts\ntest/b/c.serial.test.ts\n')).toEqual({ files: ['test/a.test.ts', 'test/b/c.serial.test.ts'], errors: [] });
  });

  test('a bad shard request prints usage', () => {
    const r = cli('shard', '3', '2');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('usage: bun scripts/postgres-unit-arms.ts shard <n> <m>');
  });

  test('the miner measures each file from its group to the next group or endgroup', () => {
    const log = [
      '2026-10-05T18:44:13.0000000Z ##[group]test/a.test.ts',
      '2026-10-05T18:44:13.0100000Z ##[group]test/a.test.ts:',
      '2026-10-05T18:44:20.0000000Z (pass) a',
      '2026-10-05T18:44:23.0000000Z ##[group]test/b.serial.test.ts',
      '2026-10-05T18:44:24.5000000Z ##[endgroup]',
    ].join('\n');
    expect(Object.fromEntries(mineArmWeights([log]))).toEqual({ 'test/a.test.ts': 10000, 'test/b.serial.test.ts': 1500 });
  });

  test('a file timed in several logs weighs its median, so one slow runner does not set it', () => {
    const log = (seconds: number) => [
      `2026-10-05T18:44:00.0000000Z ##[group]test/a.test.ts`,
      `2026-10-05T18:44:${String(seconds).padStart(2, '0')}.0000000Z ##[endgroup]`,
    ].join('\n');
    expect(mineArmWeights([log(10), log(50), log(12)]).get('test/a.test.ts')).toBe(12000);
    expect(mineArmWeights([log(10), log(50), log(12), log(14)]).get('test/a.test.ts')).toBe(13000);
  });
});
