/**
 * The Rust store's entityFeatureCoverage (src/core/rust-engine/store-members/link-queries.ts) and its sample percent.
 * The store reads every page. A 100 percent sample draws every row (TABLESAMPLE BERNOULLI (100)), so the store serves
 * it as the whole population; a lower percent is a random draw no other engine can match, so it refuses by name.
 * A malformed percent fails with the SQL engines' own message.
 */
import { describe, expect, test } from 'bun:test';
import { entityFeatureCoverage } from '../src/core/rust-engine/store-members/link-queries.ts';
import { isCapabilityMissing } from '../src/core/rust-engine/errors.ts';

const FILTER = { types: ['person'], per_source: [] };
const brain = (calls: unknown[]) => ({
  entityFeatureCoverage: async (spec: unknown) => { calls.push(spec); return { sampleSize: 2, matched: 1 }; },
}) as never;

describe('Rust store entityFeatureCoverage sample percent', () => {
  test('a 100 percent sample reads the whole population', async () => {
    const calls: unknown[] = [];
    expect(await entityFeatureCoverage(brain(calls), FILTER, 'links', { samplePercent: 100 })).toEqual({ sampleSize: 2, matched: 1 });
    expect(calls).toEqual([{ filter: FILTER, feature: 'links' }]);
  });

  test('a percent below 100 refuses by name and reads nothing', async () => {
    const calls: unknown[] = [];
    const err = await entityFeatureCoverage(brain(calls), FILTER, 'timeline', { samplePercent: 2 }).then(() => null, (e: unknown) => e);
    expect(isCapabilityMissing(err)).toBe(true);
    expect(String((err as Error).message)).toContain('entityFeatureCoverage');
    expect(calls).toEqual([]);
  });

  test('a malformed percent fails with the SQL engines\' message', async () => {
    for (const pct of [0, -1, 101, Number.NaN]) {
      const err = await entityFeatureCoverage(brain([]), FILTER, 'links', { samplePercent: pct }).then(() => null, (e: Error) => e.message);
      expect(err).toBe(`entityFeatureCoverage: samplePercent must be a number in (0, 100], got ${String(pct)}`);
    }
  });
});
