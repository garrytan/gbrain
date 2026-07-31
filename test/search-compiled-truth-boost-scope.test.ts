/**
 * #3430: the compiled_truth boost must not apply at `detail=medium`.
 *
 * `COMPILED_TRUTH_BOOST = 2.0` is applied AFTER RRF score normalization. RRF's
 * entire dynamic range over a 100-deep pool is 1/60 → 1/160 (a factor of 2.67),
 * so a 2.0x multiplier consumes roughly three quarters of it. Break-even is
 * `2/(60+r) >= 1/60`, i.e. r <= 60 — so ANY boosted chunk in the first 60 ranks
 * outranks an unboosted rank-1 chunk. That is a categorical filter, not a tilt:
 * a page whose actual answer is in a `fenced_code` chunk returns the prose
 * chunk instead, and the code chunk leaves the result window entirely.
 *
 * The gate was written as `detail !== 'high'` — "high is special" — but the
 * documented contract in `src/core/operations.ts` is:
 *
 *   low (compiled truth only), medium (default, all with dedup), high (all chunks)
 *
 * which makes LOW the special one. `low` already restricts to compiled_truth,
 * so a boost there is a no-op among equals; `medium` and `high` are both
 * supposed to see everything. Hence `detail === 'low'`.
 *
 * These tests pin the arithmetic, not the constant — they would still fail if
 * someone reintroduced a boost at medium with a different multiplier or behind
 * a score floor, which is why they assert final RANK rather than score.
 */
import { describe, test, expect } from 'bun:test';
import { rrfFusion, RRF_K, shouldBoostCompiledTruth } from '../src/core/search/hybrid.ts';
import { KNOBS_HASH_VERSION } from '../src/core/search/mode.ts';
import type { SearchResult } from '../src/core/types.ts';

function chunk(slug: string, chunkSource: string): SearchResult {
  return { slug, chunk_source: chunkSource, chunk_text: 'x', title: slug, score: 0 } as unknown as SearchResult;
}

/** One vector arm: the correct answer at rank 0, then `n` compiled_truth chunks. */
function poolWithAnswerFirst(n: number): SearchResult[] {
  const list = [chunk('code/answer', 'fenced_code')];
  for (let i = 0; i < n; i++) list.push(chunk(`prose/p${i}`, 'compiled_truth'));
  return list;
}

function rankOfAnswer(results: SearchResult[]): number {
  return results.findIndex((r) => r.slug === 'code/answer');
}

describe('#3430: the detail→boost mapping itself', () => {
  // These are the assertions that actually FAIL on master. The rrfFusion tests
  // below pin the arithmetic but pass either way, because they pass the boost
  // flag explicitly — they cannot see how hybridSearch decides it. This is the
  // wiring.
  test('ONLY detail=low boosts compiled_truth', () => {
    expect(shouldBoostCompiledTruth('low')).toBe(true);
    expect(shouldBoostCompiledTruth('medium')).toBe(false);
    expect(shouldBoostCompiledTruth('high')).toBe(false);
  });

  test('an absent detail does not boost — medium is the documented default', () => {
    // Callers that omit detail get medium semantics, so the unset case must
    // match medium, not low. A `!== 'high'` spelling gets this backwards.
    expect(shouldBoostCompiledTruth(undefined)).toBe(false);
    expect(shouldBoostCompiledTruth(null)).toBe(false);
  });

  test('an unrecognized detail value does not boost', () => {
    // Fail-open toward showing everything rather than silently filtering.
    expect(shouldBoostCompiledTruth('')).toBe(false);
    expect(shouldBoostCompiledTruth('LOW')).toBe(false);
    expect(shouldBoostCompiledTruth('detailed')).toBe(false);
  });

  test('the cache version was bumped so pre-fix rankings are unreachable', () => {
    // Results are cached AFTER fusion, so rows written under the old boost
    // semantics would otherwise be served under the new ones for the whole TTL.
    // 13 was the pre-fix value.
    expect(KNOBS_HASH_VERSION).toBeGreaterThanOrEqual(14);
  });
});

describe('#3430: compiled_truth boost scope', () => {
  test('boost OFF (detail=medium/high) keeps the vector-ranked answer at rank 0', () => {
    // The regression this file exists for. Pre-fix, medium passed applyBoost=true
    // and the answer landed at rank n — outside a 20-result window for n >= 20.
    for (const n of [10, 20, 40, 80]) {
      const fused = rrfFusion([poolWithAnswerFirst(n)], RRF_K, false);
      expect(rankOfAnswer(fused), `n=${n}: answer must stay first without the boost`).toBe(0);
    }
  });

  test('boost ON demonstrates the categorical displacement it causes', () => {
    // Documents WHY the boost cannot be on at medium. Not an endorsement of
    // these numbers — a characterization of the mechanism, so a future reader
    // sees the cost rather than re-deriving it.
    const observed = [10, 20, 40].map((n) => ({
      n,
      rank: rankOfAnswer(rrfFusion([poolWithAnswerFirst(n)], RRF_K, true)),
    }));
    // Displacement scales with pool composition: the answer is pushed back by
    // roughly one position per boosted chunk ahead of the break-even rank.
    for (const { n, rank } of observed) {
      expect(rank, `n=${n}: boosted chunks should displace the answer`).toBeGreaterThan(0);
    }
    // And past ~20 compiled_truth chunks it leaves a default-size window.
    expect(observed.find((o) => o.n === 20)!.rank).toBeGreaterThanOrEqual(20);
  });

  test('with the boost off, compiled_truth still wins when the vector arm ranks it first', () => {
    // Guard against over-correcting: removing the boost must not penalize
    // compiled_truth, only stop privileging it.
    const list = [chunk('prose/answer', 'compiled_truth'), chunk('code/other', 'fenced_code')];
    const fused = rrfFusion([list], RRF_K, false);
    expect(fused[0].slug).toBe('prose/answer');
  });
});
