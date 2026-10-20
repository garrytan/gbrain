/**
 * The ci:ubicloud gate's unit-shard check and test.yml's budget guard are one check: the gate holds the same
 * partition (scripts/test-shard.sh via unitShardPlan), the same mined weights (scripts/test-weights.json) and
 * the same UNIT_SHARD_BUDGET_MS as test/scripts/unit-shard-budget.test.ts.
 * Fails when: the gate partitions, weighs or budgets unit shards on its own again (its own 1,260 s limit over
 * measured time failed GBRA-95's gate at 1,274 s for a shard every GitHub guard passed), or measured gate time
 * gates the run.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { unitShardCheck } from '../../scripts/ci-ubicloud.ts';
import { UNIT_SHARD_BUDGET_MS, unitShardPlan } from '../../scripts/sharding.ts';

const REPO = join(import.meta.dir, '..', '..');

describe('ci:ubicloud unit shard check', () => {
  const plan = unitShardPlan(REPO);
  const guarded = plan.filter(({ ms }) => ms > UNIT_SHARD_BUDGET_MS).map(({ shard }) => shard);

  test('checks the partition, mined weights and budget the GitHub guard checks', () => {
    const gate = unitShardCheck(REPO, () => undefined);
    expect(gate.budgetMs).toBe(UNIT_SHARD_BUDGET_MS);
    expect(gate.shards.map(({ shard, files, mined }) => ({ shard, files, mined })))
      .toEqual(plan.map(({ shard, files, ms }) => ({ shard, files: files.length, mined: ms })));
    expect(gate.shards.every(({ unmeasured, files }) => unmeasured === files)).toBe(true);
    expect(gate.overBudget.map(({ shard }) => shard)).toEqual(guarded);
  });

  test('measured gate time is reported, never gating: a 1,274 s file leaves the verdict to the mined plan', () => {
    const gate = unitShardCheck(REPO, () => 1_274_000);
    expect(gate.shards.map(({ shard, ms, files }) => ({ shard, ms: ms / files })))
      .toEqual(plan.map(({ shard }) => ({ shard, ms: 1_274_000 })));
    expect(gate.overBudget.map(({ shard }) => shard)).toEqual(guarded);
  });
});
