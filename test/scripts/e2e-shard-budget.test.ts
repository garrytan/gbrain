/**
 * E2E shard-time guard (GBRA-135 L7). Selected E2E and the Tier 1 graduation
 * shards run their files one at a time inside a job timeout, so a shard's
 * predicted time times the measured actual/predicted factor, plus setup and a
 * minute to spare, must fit that timeout. scripts/e2e-weights.json predicted
 * 4,945 s for E2E files that took 9,969 s on full run 40798858961 (factor
 * 2.02) without anything noticing; this test keeps that factor in the budget,
 * so a bigger corpus or fewer workers fails here instead of at a job timeout.
 * Re-mine the weights (scripts/mine-shard-weights.ts) and measure the factor
 * again before lowering it.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { load } from 'js-yaml';
import { E2E_EXCLUSIONS, MAX_E2E_WORKERS, prepareMatrix } from '../../scripts/e2e-matrix.ts';
import { loadWeights, partition, predictedWeight, type WeightMap } from '../../scripts/sharding.ts';

const REPO = join(import.meta.dir, '..', '..');
const ACTUAL_OVER_PREDICTED = 2.02;
const SETUP_ALLOWANCE_MS = 2 * 60_000;
const SPARE_MS = 60_000;
type Job = { 'timeout-minutes': number };
const jobs = (load(readFileSync(join(REPO, '.github/workflows/e2e.yml'), 'utf8')) as { jobs: Record<string, Job> }).jobs;
const weights = loadWeights(join(REPO, 'scripts/e2e-weights.json'));

function overBudget(shards: string[][], w: WeightMap, timeoutMinutes: number) {
  const budget = timeoutMinutes * 60_000 - SETUP_ALLOWANCE_MS - SPARE_MS;
  return shards
    .map((files, i) => ({ shard: i + 1, expectedMs: Math.round(predictedWeight(files, w).totalMs * ACTUAL_OVER_PREDICTED) }))
    .filter(s => s.expectedMs > budget);
}

describe('E2E shard-time budget', () => {
  test('every Selected E2E shard of the full corpus fits the job timeout at the measured factor', () => {
    const selected = spawnSync(process.execPath, [join(REPO, 'scripts/select-e2e.ts'), '--changed-files', '/dev/null'], { cwd: REPO, encoding: 'utf8' });
    expect(selected.status, selected.stderr).toBe(0);
    const files = selected.stdout.trim().split('\n').filter(Boolean);
    expect(files.length).toBeGreaterThan(100);
    const matrix = prepareMatrix(files, weights);
    expect(matrix.include).toHaveLength(MAX_E2E_WORKERS);
    expect(overBudget(matrix.include.map(r => r.files), weights, jobs['selected-e2e']['timeout-minutes'])).toEqual([]);
  });

  test('both Tier 1 graduation shards fit the job timeout at the measured factor', () => {
    const graduation = [...E2E_EXCLUSIONS].filter(f => f.startsWith('test/e2e/graduation-'));
    expect(graduation).toHaveLength(15);
    expect(overBudget(partition(graduation, weights, 2), weights, jobs['tier1-graduation']['timeout-minutes'])).toEqual([]);
  });

  test('a shard whose predicted time times the factor passes the timeout is reported', () => {
    const w: WeightMap = new Map([['test/e2e/a.test.ts', 20 * 60_000], ['test/e2e/b.test.ts', 10 * 60_000]]);
    expect(overBudget([['test/e2e/a.test.ts'], ['test/e2e/b.test.ts']], w, 30)).toEqual([{ shard: 1, expectedMs: 2_424_000 }]);
  });
});
