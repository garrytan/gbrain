/**
 * test.yml's unit shards run inside the `test` job's timeout-minutes. A
 * shard's mined weight must fit that timeout twice over, after setup, with a
 * minute to spare: master shards ran up to 1.4x their prediction, and shard
 * 5/10 of run 39121354115 was cancelled at the timeout with no failing test.
 * test/scripts/ci-gates.test.ts pins the workflows' shard counts to UNIT_SHARDS.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';
import {
  MEMORY_HEAVY_UNIT_FILES,
  UNIT_JOB_TIMEOUT_MS,
  UNIT_SETUP_ALLOWANCE_MS,
  UNIT_SHARD_BUDGET_MS,
  UNIT_SHARDS,
  UNIT_SHARDS_PER_JOB,
  unitShardPlan,
} from '../../scripts/sharding.ts';

const REPO = join(import.meta.dir, '..', '..');
type Job = { 'timeout-minutes': number };
const jobs = (name: string) => (load(readFileSync(join(REPO, '.github', 'workflows', name), 'utf8')) as { jobs: Record<string, Job> }).jobs;

describe('unit shard budget', () => {
  test('the unit jobs\' timeouts are UNIT_JOB_TIMEOUT_MS or longer', () => {
    expect(jobs('test.yml').test['timeout-minutes']).toBe(UNIT_JOB_TIMEOUT_MS / 60_000);
    expect(jobs('e2e.yml')['coverage-full-unit']['timeout-minutes']).toBeGreaterThanOrEqual(UNIT_JOB_TIMEOUT_MS / 60_000);
  });

  test('every unit shard\'s mined weight fits the job twice over, after setup, with a minute to spare', () => {
    expect(2 * UNIT_SHARD_BUDGET_MS + UNIT_SETUP_ALLOWANCE_MS + 60_000).toBe(UNIT_JOB_TIMEOUT_MS);
    const plan = unitShardPlan(REPO);
    expect(plan.every(({ files }) => files.length > 0)).toBe(true);
    const over = plan
      .map(({ shard, ms }) => ({ shard: `${shard}/${UNIT_SHARDS}`, ms }))
      .filter(s => s.ms > UNIT_SHARD_BUDGET_MS);
    expect(over).toEqual([]);
  }, UNIT_SHARDS * 1_000);

  test('no test.yml runner holds more than its share of the memory-heavy files', () => {
    expect(MEMORY_HEAVY_UNIT_FILES.filter(f => !existsSync(join(REPO, f)))).toEqual([]);
    const plan = unitShardPlan(REPO);
    const heavy = new Set(MEMORY_HEAVY_UNIT_FILES);
    const runners = Math.ceil(UNIT_SHARDS / UNIT_SHARDS_PER_JOB);
    const share = Math.ceil(heavy.size / runners);
    const over = Array.from({ length: runners }, (_, r) => plan.slice(r * UNIT_SHARDS_PER_JOB, (r + 1) * UNIT_SHARDS_PER_JOB))
      .map(shards => ({ shards: shards.map(s => s.shard).join(','), heavy: shards.flatMap(s => s.files).filter(f => heavy.has(f)) }))
      .filter(r => r.heavy.length > share);
    expect(over).toEqual([]);
    expect(plan.flatMap(s => s.files).filter(f => heavy.has(f)).length).toBe(heavy.size);
  }, UNIT_SHARDS * 1_000);
});
