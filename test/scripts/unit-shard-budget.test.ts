/**
 * test.yml's unit shards run inside the `test` job's 22-minute timeout. A
 * shard's mined weight must fit that timeout twice over, after setup, with a
 * minute to spare: master shards ran up to 1.4x their prediction, and shard
 * 5/10 of run 39121354115 was cancelled at the timeout with no failing test.
 * test/scripts/ci-gates.test.ts pins the workflows' shard counts to UNIT_SHARDS.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';
import {
  loadWeights,
  predictedWeight,
  UNIT_JOB_TIMEOUT_MS,
  UNIT_SETUP_ALLOWANCE_MS,
  UNIT_SHARD_BUDGET_MS,
  UNIT_SHARDS,
  unitShards,
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
    const weights = loadWeights(join(REPO, 'scripts', 'test-weights.json'));
    const shards = unitShards(REPO);
    expect(shards.every(files => files.length > 0)).toBe(true);
    const over = shards
      .map((files, i) => ({ shard: `${i + 1}/${UNIT_SHARDS}`, ms: Math.round(predictedWeight(files, weights).totalMs) }))
      .filter(s => s.ms > UNIT_SHARD_BUDGET_MS);
    expect(over).toEqual([]);
  });
});
