/**
 * v0.40.4.0 — per-stage attribution stamping (T6, D12=A).
 *
 * Every boost stage that mutates SearchResult.score also stamps a field
 * recording WHAT it multiplied. The `--explain` formatter (T7) reads
 * these fields to attribute final score to its components.
 *
 * Pinned:
 *   - applyBacklinkBoost stamps backlink_boost
 *   - applySalienceBoost stamps salience_boost
 *   - applyRecencyBoost stamps recency_boost
 *   - applyExactMatchBoost stamps exact_match_boost
 *   - runPostFusionStages stamps base_score ONCE at entry (idempotent)
 *   - applyReranker stamps reranker_delta (rank delta, positive = improved)
 *   - applyGraphSignals stamps graph_adjacency_boost,
 *     graph_cross_source_boost, session_demote_factor (covered in
 *     graph-signals.test.ts)
 */

import { describe, test, expect } from 'bun:test';
import type { SearchResult } from '../../src/core/types.ts';
import {
  applyBacklinkBoost,
  applySalienceBoost,
  applyRecencyBoost,
  runPostFusionStages,
} from '../../src/core/search/hybrid.ts';
import { applyExactMatchBoost } from '../../src/core/search/intent-weights.ts';
import { applyReranker } from '../../src/core/search/rerank.ts';

function r(slug: string, score: number, page_id = 1): SearchResult {
  return {
    slug,
    page_id,
    title: slug,
    type: 'note',
    chunk_text: `body of ${slug}`,
    chunk_source: 'compiled_truth',
    chunk_id: page_id * 1000,
    chunk_index: 0,
    score,
    stale: false,
    source_id: 'default',
  };
}

describe('applyBacklinkBoost — attribution', () => {
  test('count > 0 → backlink_boost stamped with the actual factor', () => {
    const results = [r('a/b', 1.0, 1)];
    const counts = new Map([['a/b', 10]]);
    applyBacklinkBoost(results, counts);
    expect(results[0].backlink_boost).toBeGreaterThan(1.0);
    expect(results[0].backlink_boost).toBeLessThan(2.0);
    // Score should be multiplied by the same factor.
    expect(results[0].score).toBeCloseTo(results[0].backlink_boost!, 5);
  });

  test('count = 0 → no stamp', () => {
    const results = [r('a/b', 1.0, 1)];
    applyBacklinkBoost(results, new Map([['a/b', 0]]));
    expect(results[0].backlink_boost).toBeUndefined();
    expect(results[0].score).toBe(1.0);
  });

  test('below floor → no stamp', () => {
    const results = [r('weak', 0.1, 1)];
    applyBacklinkBoost(results, new Map([['weak', 10]]), 0.5);
    expect(results[0].backlink_boost).toBeUndefined();
    expect(results[0].score).toBe(0.1);
  });
});

describe('applySalienceBoost — attribution', () => {
  test('score > 0 → salience_boost stamped', () => {
    const results = [r('a/b', 1.0, 1)];
    const scores = new Map([['default::a/b', 5]]);
    applySalienceBoost(results, scores, 'on');
    expect(results[0].salience_boost).toBeGreaterThan(1.0);
    expect(results[0].score).toBeCloseTo(results[0].salience_boost!, 5);
  });

  test('score = 0 → no stamp', () => {
    const results = [r('a/b', 1.0, 1)];
    applySalienceBoost(results, new Map(), 'on');
    expect(results[0].salience_boost).toBeUndefined();
    expect(results[0].score).toBe(1.0);
  });
});

describe('applyRecencyBoost — attribution', () => {
  test('date present + non-evergreen prefix → recency_boost stamped', () => {
    const results = [r('media/notes/today', 1.0, 1)];
    const dates = new Map([['default::media/notes/today', new Date()]]);
    const decayMap = { 'media/': { halflifeDays: 7, coefficient: 0.5 } };
    const fallback = { halflifeDays: 30, coefficient: 0.2 };
    applyRecencyBoost(results, dates, 'on', decayMap, fallback);
    expect(results[0].recency_boost).toBeGreaterThan(1.0);
    expect(results[0].score).toBeCloseTo(results[0].recency_boost!, 5);
  });

  test('evergreen prefix (halflife=0) → no stamp', () => {
    const results = [r('docs/forever', 1.0, 1)];
    const dates = new Map([['default::docs/forever', new Date()]]);
    const decayMap = { 'docs/': { halflifeDays: 0, coefficient: 0 } };
    const fallback = { halflifeDays: 30, coefficient: 0 };
    applyRecencyBoost(results, dates, 'on', decayMap, fallback);
    expect(results[0].recency_boost).toBeUndefined();
    expect(results[0].score).toBe(1.0);
  });
});

describe('applyExactMatchBoost — attribution', () => {
  test('slug exact-match → exact_match_boost stamped', () => {
    const results = [r('people/garry-tan', 1.0, 1)];
    applyExactMatchBoost(results, 'garry-tan', { exactMatchBoost: 1.5 } as any);
    expect(results[0].exact_match_boost).toBe(1.5);
    expect(results[0].score).toBe(1.5);
  });

  test('no match → no stamp', () => {
    const results = [r('people/alice', 1.0, 1)];
    applyExactMatchBoost(results, 'bob', { exactMatchBoost: 1.5 } as any);
    expect(results[0].exact_match_boost).toBeUndefined();
    expect(results[0].score).toBe(1.0);
  });

  test('boost = 1.0 (no-op intent) → no stamp', () => {
    const results = [r('people/alice', 1.0, 1)];
    applyExactMatchBoost(results, 'alice', { exactMatchBoost: 1.0 } as any);
    expect(results[0].exact_match_boost).toBeUndefined();
  });
});

describe('runPostFusionStages — base_score stamp', () => {
  test('stamps base_score on every result at entry', async () => {
    const results = [r('a/b', 5.0, 1), r('c/d', 3.0, 2)];
    await runPostFusionStages({} as any, results, {
      applyBacklinks: false,
      salience: 'off',
      recency: 'off',
    });
    expect(results[0].base_score).toBe(5.0);
    expect(results[1].base_score).toBe(3.0);
  });

  test('idempotent: preserves base_score if caller pre-stamped', async () => {
    const results = [r('a/b', 5.0, 1)];
    results[0].base_score = 99;  // caller-stamped
    await runPostFusionStages({} as any, results, {
      applyBacklinks: false,
      salience: 'off',
      recency: 'off',
    });
    expect(results[0].base_score).toBe(99);
  });

  test('base_score captures pre-boost score even when boosts run', async () => {
    const results = [r('a/b', 10.0, 1)];
    const fakeEngine = {
      getBacklinkCounts: async () => new Map([['a/b', 5]]),
    } as any;
    await runPostFusionStages(fakeEngine, results, {
      applyBacklinks: true,
      salience: 'off',
      recency: 'off',
    });
    expect(results[0].base_score).toBe(10.0);
    expect(results[0].score).toBeGreaterThan(10.0);  // boosted
    expect(results[0].backlink_boost).toBeGreaterThan(1.0);
  });

  test('empty results → no-op (no stamping)', async () => {
    await runPostFusionStages({} as any, [], {
      applyBacklinks: false, salience: 'off', recency: 'off',
    });
    // No throw == pass.
  });
});

describe('applyReranker — attribution', () => {
  test('rank improved → reranker_delta positive', async () => {
    const results = [
      r('a', 10, 1),
      r('b', 9, 2),
      r('c', 8, 3),
    ];
    // Reranker says: c is the best (index 2 → position 0), then a (0 → 1), then b (1 → 2).
    const fakeRerank = async () => [
      { index: 2, relevanceScore: 0.95 },
      { index: 0, relevanceScore: 0.85 },
      { index: 1, relevanceScore: 0.75 },
    ];
    const reordered = await applyReranker('query', results, {
      enabled: true,
      topNIn: 30,
      topNOut: null,
      model: 'test',
      timeoutMs: 1000,
      rerankerFn: fakeRerank as any,
    });
    // c moved from index 2 → 0 → delta = 2.
    const c = reordered.find(r => r.slug === 'c')!;
    expect(c.reranker_delta).toBe(2);
    // a moved from index 0 → 1 → delta = -1.
    const a = reordered.find(r => r.slug === 'a')!;
    expect(a.reranker_delta).toBe(-1);
  });

  test('no reranker call → reranker_delta undefined', () => {
    const result = r('a/b', 10, 1);
    expect(result.reranker_delta).toBeUndefined();
  });
});
