/**
 * Search pipeline unit tests — RRF normalization, compiled truth boost,
 * cosine similarity, dedup key, and CJK word count.
 */

import { describe, test, expect } from 'bun:test';
import {
  rrfFusion,
  cosineSimilarity,
  applyBacklinkBoost,
  applySalienceBoost,
  applyRecencyBoost,
  computeFloorThreshold,
  runPostFusionStages,
  type PostFusionOpts,
} from '../src/core/search/hybrid.ts';
import {
  DEFAULT_RECENCY_DECAY,
  DEFAULT_FALLBACK,
} from '../src/core/search/recency-decay.ts';
import type { SearchResult } from '../src/core/types.ts';

function makeResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    slug: 'test-page',
    page_id: 1,
    title: 'Test',
    type: 'concept',
    chunk_text: 'test chunk text',
    chunk_source: 'compiled_truth',
    chunk_id: 1,
    chunk_index: 0,
    score: 0,
    stale: false,
    ...overrides,
  };
}

describe('rrfFusion', () => {
  test('normalizes scores to 0-1 range', () => {
    const list: SearchResult[] = [
      makeResult({ slug: 'a', chunk_id: 1, chunk_text: 'aaa' }),
      makeResult({ slug: 'b', chunk_id: 2, chunk_text: 'bbb' }),
    ];
    const results = rrfFusion([list], 60);
    // Top result should have score >= 1.0 (normalized to 1.0, then boosted 2.0x for compiled_truth)
    expect(results[0].score).toBe(2.0); // 1.0 * 2.0 boost
  });

  test('boosts compiled_truth chunks 2x over timeline', () => {
    const compiledChunk = makeResult({ slug: 'a', chunk_id: 1, chunk_source: 'compiled_truth', chunk_text: 'compiled text' });
    const timelineChunk = makeResult({ slug: 'b', chunk_id: 2, chunk_source: 'timeline', chunk_text: 'timeline text' });

    // Put timeline first (higher rank) in the list
    const results = rrfFusion([[timelineChunk, compiledChunk]], 60);

    // Timeline was rank 0, compiled was rank 1
    // Timeline raw: 1/(60+0) = 0.01667, compiled raw: 1/(60+1) = 0.01639
    // Normalized: timeline = 1.0, compiled = 0.983
    // Boosted: timeline = 1.0 * 1.0 = 1.0, compiled = 0.983 * 2.0 = 1.967
    // Compiled should now rank first
    expect(results[0].slug).toBe('a');
    expect(results[0].chunk_source).toBe('compiled_truth');
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  test('timeline-only results are not boosted', () => {
    const list: SearchResult[] = [
      makeResult({ slug: 'a', chunk_id: 1, chunk_source: 'timeline', chunk_text: 'tl1' }),
      makeResult({ slug: 'b', chunk_id: 2, chunk_source: 'timeline', chunk_text: 'tl2' }),
    ];
    const results = rrfFusion([list], 60);
    // Top result: normalized to 1.0, no boost (timeline = 1.0x)
    expect(results[0].score).toBe(1.0);
  });

  test('returns empty for empty lists', () => {
    expect(rrfFusion([], 60)).toEqual([]);
    expect(rrfFusion([[]], 60)).toEqual([]);
  });

  test('single result normalizes to 1.0 before boost', () => {
    const results = rrfFusion([[makeResult({ chunk_source: 'timeline' })]], 60);
    expect(results).toHaveLength(1);
    expect(results[0].score).toBe(1.0); // 1.0 normalized * 1.0 timeline boost
  });

  test('uses chunk_id for dedup key when available', () => {
    const chunk1 = makeResult({ slug: 'a', chunk_id: 10, chunk_text: 'same prefix text' });
    const chunk2 = makeResult({ slug: 'a', chunk_id: 20, chunk_text: 'same prefix text' });

    const results = rrfFusion([[chunk1, chunk2]], 60);
    // Both should survive because chunk_id differs
    expect(results).toHaveLength(2);
  });

  test('falls back to text prefix when chunk_id is missing', () => {
    const chunk1 = makeResult({ slug: 'a', chunk_id: undefined as any, chunk_text: 'same text' });
    const chunk2 = makeResult({ slug: 'a', chunk_id: undefined as any, chunk_text: 'same text' });

    const results = rrfFusion([[chunk1, chunk2]], 60);
    // Same slug + same text prefix = collapsed to 1
    expect(results).toHaveLength(1);
  });

  test('merges scores across multiple lists', () => {
    const chunk = makeResult({ slug: 'a', chunk_id: 1, chunk_source: 'timeline' });
    // Chunk appears at rank 0 in both lists
    const results = rrfFusion([[chunk], [{ ...chunk }]], 60);
    expect(results).toHaveLength(1);
    // Score should be 2 * 1/(60+0) = 0.0333, normalized to 1.0, no boost
    expect(results[0].score).toBe(1.0);
  });

  test('respects custom K parameter', () => {
    const list = [makeResult({ chunk_source: 'timeline' })];
    const k30 = rrfFusion([list], 30);
    const k90 = rrfFusion([list], 90);
    // Both have single result, normalized to 1.0
    expect(k30[0].score).toBe(1.0);
    expect(k90[0].score).toBe(1.0);
  });
});

describe('cosineSimilarity', () => {
  test('identical vectors return 1.0', () => {
    const v = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 5);
  });

  test('orthogonal vectors return 0.0', () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0, 5);
  });

  test('opposite vectors return -1.0', () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([-1, 0, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0, 5);
  });

  test('zero vector returns 0.0 (no division by zero)', () => {
    const zero = new Float32Array([0, 0, 0]);
    const v = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(zero, v)).toBe(0);
    expect(cosineSimilarity(v, zero)).toBe(0);
    expect(cosineSimilarity(zero, zero)).toBe(0);
  });

  test('works with high-dimensional vectors', () => {
    const dim = 1536;
    const a = new Float32Array(dim).fill(1);
    const b = new Float32Array(dim).fill(1);
    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0, 5);
  });

  test('basis vectors are orthogonal', () => {
    const dim = 10;
    const a = new Float32Array(dim);
    const b = new Float32Array(dim);
    a[0] = 1.0;
    b[5] = 1.0;
    expect(cosineSimilarity(a, b)).toBe(0);
  });
});

describe('CJK word count in expansion', () => {
  test('CJK characters are counted individually', async () => {
    // Import the module to test CJK detection logic
    const hasCJK = /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test('向量搜索');
    expect(hasCJK).toBe(true);

    const query = '向量搜索优化';
    const wordCount = query.replace(/\s/g, '').length;
    expect(wordCount).toBe(6); // 6 CJK chars, not 1 "word"
  });

  test('non-CJK uses space-delimited counting', () => {
    const hasCJK = /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test('hello world');
    expect(hasCJK).toBe(false);

    const query = 'hello world';
    const wordCount = (query.match(/\S+/g) || []).length;
    expect(wordCount).toBe(2);
  });

  test('Japanese hiragana detected as CJK', () => {
    const hasCJK = /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test('こんにちは');
    expect(hasCJK).toBe(true);
  });

  test('Korean hangul detected as CJK', () => {
    const hasCJK = /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test('안녕하세요');
    expect(hasCJK).toBe(true);
  });

  test('mixed CJK+Latin uses CJK counting', () => {
    const query = 'AI 向量搜索';
    const hasCJK = /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(query);
    expect(hasCJK).toBe(true);
    const wordCount = query.replace(/\s/g, '').length;
    expect(wordCount).toBe(6); // "AI向量搜索" = 6 chars
  });
});

describe('applyBacklinkBoost (v0.10.1)', () => {
  test('zero backlinks: no change to score', () => {
    const results: SearchResult[] = [makeResult({ slug: 'a', score: 1.0 })];
    applyBacklinkBoost(results, new Map());
    expect(results[0].score).toBe(1.0);
  });

  test('positive backlinks boost score by formula (1 + 0.05 * log(1 + count))', () => {
    const results: SearchResult[] = [makeResult({ slug: 'popular', score: 1.0 })];
    applyBacklinkBoost(results, new Map([['popular', 10]]));
    // 1.0 * (1 + 0.05 * log(11)) ≈ 1.0 * 1.1199
    const expected = 1.0 * (1 + 0.05 * Math.log(11));
    expect(results[0].score).toBeCloseTo(expected, 4);
  });

  test('higher count = larger boost (log scaling)', () => {
    const a: SearchResult[] = [makeResult({ slug: 'a', score: 1.0 })];
    const b: SearchResult[] = [makeResult({ slug: 'b', score: 1.0 })];
    applyBacklinkBoost(a, new Map([['a', 1]]));
    applyBacklinkBoost(b, new Map([['b', 100]]));
    expect(b[0].score).toBeGreaterThan(a[0].score);
  });

  test('mutates results in place (no return value)', () => {
    const results: SearchResult[] = [makeResult({ slug: 'x', score: 1.0 })];
    const ret = applyBacklinkBoost(results, new Map([['x', 5]]));
    expect(ret).toBeUndefined();
    expect(results[0].score).toBeGreaterThan(1.0);
  });

  test('slug not in counts map: no boost', () => {
    const results: SearchResult[] = [makeResult({ slug: 'unknown', score: 0.5 })];
    applyBacklinkBoost(results, new Map([['other', 100]]));
    expect(results[0].score).toBe(0.5);
  });

  test('multiple results with mixed counts: each scored independently', () => {
    const results: SearchResult[] = [
      makeResult({ slug: 'a', score: 1.0 }),
      makeResult({ slug: 'b', score: 1.0 }),
      makeResult({ slug: 'c', score: 1.0 }),
    ];
    applyBacklinkBoost(results, new Map([['a', 0], ['b', 5], ['c', 50]]));
    expect(results[0].score).toBe(1.0);
    expect(results[1].score).toBeGreaterThan(1.0);
    expect(results[2].score).toBeGreaterThan(results[1].score);
  });
});

/**
 * v0.35.6.0 — floor-ratio gate test surface.
 *
 * Decisions captured in `~/.claude/plans/swift-sniffing-nygaard.md`:
 *  - D6=A: single up-front threshold computed at runPostFusionStages entry
 *  - D7=A: SearchOpts.floorRatio + search.floor_ratio config key (no env)
 *  - D8=B: gate scoped to metadata stages; exact-match un-gated by design
 *  - D9=A: global floor (cross-source); no special docs
 *
 * Codex outside-voice correctness fixes pinned by these tests:
 *  - T1: cache contamination — pinned by knobsHash coverage in search-mode.test.ts
 *  - T1a: NaN scores skip the gate — pinned here
 *  - T1b: negative top scores leave gate disabled — pinned here
 *  - T2: per-stage recompute is wrong — pinned by single-baseline test below
 */
describe('computeFloorThreshold', () => {
  test('undefined floorRatio returns -Infinity (no gate)', () => {
    const results: SearchResult[] = [makeResult({ score: 1.0 })];
    expect(computeFloorThreshold(results, undefined)).toBe(Number.NEGATIVE_INFINITY);
  });

  test('empty results array returns -Infinity even when floorRatio set', () => {
    expect(computeFloorThreshold([], 0.85)).toBe(Number.NEGATIVE_INFINITY);
  });

  test('valid 0.85 + top=1.0 returns 0.85', () => {
    const results: SearchResult[] = [
      makeResult({ slug: 'top', score: 1.0 }),
      makeResult({ slug: 'mid', score: 0.5 }),
    ];
    expect(computeFloorThreshold(results, 0.85)).toBeCloseTo(0.85, 10);
  });

  test('out-of-range floorRatio (negative) disables gate', () => {
    const results: SearchResult[] = [makeResult({ score: 1.0 })];
    expect(computeFloorThreshold(results, -0.5)).toBe(Number.NEGATIVE_INFINITY);
  });

  test('out-of-range floorRatio (>1) disables gate', () => {
    const results: SearchResult[] = [makeResult({ score: 1.0 })];
    expect(computeFloorThreshold(results, 1.5)).toBe(Number.NEGATIVE_INFINITY);
  });

  test('NaN floorRatio disables gate', () => {
    const results: SearchResult[] = [makeResult({ score: 1.0 })];
    expect(computeFloorThreshold(results, NaN)).toBe(Number.NEGATIVE_INFINITY);
  });

  test('Infinity floorRatio disables gate', () => {
    const results: SearchResult[] = [makeResult({ score: 1.0 })];
    expect(computeFloorThreshold(results, Infinity)).toBe(Number.NEGATIVE_INFINITY);
  });

  test('T1b: negative-only top score disables gate (no positive signal)', () => {
    // Codex outside-voice: PR's single-result test claimed "trivially
    // eligible". With negative top (-0.5), threshold = -0.425 and the top
    // itself fails `r.score < threshold`. We return -Infinity instead so
    // no-positive-signal inputs never gate anything.
    const results: SearchResult[] = [makeResult({ score: -0.5 })];
    expect(computeFloorThreshold(results, 0.85)).toBe(Number.NEGATIVE_INFINITY);
  });

  test('T1a: all-NaN scores leave gate disabled', () => {
    const results: SearchResult[] = [
      makeResult({ score: NaN }),
      makeResult({ score: NaN }),
    ];
    expect(computeFloorThreshold(results, 0.85)).toBe(Number.NEGATIVE_INFINITY);
  });

  test('mixed NaN + finite: top is picked from finite scores only', () => {
    const results: SearchResult[] = [
      makeResult({ slug: 'nan', score: NaN }),
      makeResult({ slug: 'real', score: 1.0 }),
    ];
    expect(computeFloorThreshold(results, 0.85)).toBeCloseTo(0.85, 10);
  });
});

describe('applyBacklinkBoost — floor gate', () => {
  test('floorThreshold undefined preserves prior behavior bit-for-bit', () => {
    const results: SearchResult[] = [
      makeResult({ slug: 'top', score: 1.0 }),
      makeResult({ slug: 'weak', score: 0.3 }),
    ];
    applyBacklinkBoost(results, new Map([['top', 10], ['weak', 10]]));
    const factor = 1 + 0.05 * Math.log(11);
    expect(results[0].score).toBeCloseTo(1.0 * factor, 6);
    expect(results[1].score).toBeCloseTo(0.3 * factor, 6);
  });

  test('weak result below threshold gets no boost', () => {
    const results: SearchResult[] = [
      makeResult({ slug: 'top', score: 1.0 }),
      makeResult({ slug: 'weak', score: 0.3 }),
    ];
    applyBacklinkBoost(results, new Map([['top', 10], ['weak', 10]]), 0.85);
    const factor = 1 + 0.05 * Math.log(11);
    expect(results[0].score).toBeCloseTo(1.0 * factor, 6);
    expect(results[1].score).toBe(0.3); // gated out
  });

  test('borderline result at exactly threshold is eligible', () => {
    const results: SearchResult[] = [
      makeResult({ slug: 'top', score: 1.0 }),
      makeResult({ slug: 'edge', score: 0.85 }),
    ];
    applyBacklinkBoost(results, new Map([['top', 10], ['edge', 10]]), 0.85);
    const factor = 1 + 0.05 * Math.log(11);
    expect(results[1].score).toBeCloseTo(0.85 * factor, 6);
  });

  test('regression scenario: 1000-backlink weak result cannot leapfrog strong primary', () => {
    const withGate: SearchResult[] = [
      makeResult({ slug: 'strong-primary', score: 1.0 }),
      makeResult({ slug: 'weak-with-signal', score: 0.5 }),
    ];
    applyBacklinkBoost(withGate, new Map([['weak-with-signal', 1000]]), 0.85);
    withGate.sort((a, b) => b.score - a.score);
    expect(withGate[0].slug).toBe('strong-primary');
    expect(withGate[1].slug).toBe('weak-with-signal');
    expect(withGate[1].score).toBe(0.5);
  });

  test('T1a regression: NaN scores skip the boost (do not pass-through)', () => {
    // Codex outside-voice: `NaN < threshold` is false in JS, which would
    // otherwise let NaN rows BYPASS the gate and receive boosts. NaN scores
    // are skipped entirely.
    const results: SearchResult[] = [
      makeResult({ slug: 'top', score: 1.0 }),
      makeResult({ slug: 'nan', score: NaN }),
    ];
    applyBacklinkBoost(results, new Map([['top', 10], ['nan', 10]]), 0.85);
    expect(results[1].score).toBeNaN(); // unchanged
  });

  test('empty results array is a no-op', () => {
    const results: SearchResult[] = [];
    expect(() => applyBacklinkBoost(results, new Map(), 0.85)).not.toThrow();
  });
});

describe('applySalienceBoost — floor gate', () => {
  test('T6 (IRON RULE): weak result gated out (parity with backlink)', () => {
    const results: SearchResult[] = [
      makeResult({ slug: 'top', score: 1.0, source_id: undefined }),
      makeResult({ slug: 'weak', score: 0.3, source_id: undefined }),
    ];
    const scores = new Map([
      ['default::top', 5],
      ['default::weak', 5],
    ]);
    applySalienceBoost(results, scores, 'on', 0.85);
    const factor = 1 + 0.15 * Math.log(6);
    expect(results[0].score).toBeCloseTo(1.0 * factor, 6);
    expect(results[1].score).toBe(0.3); // gated
  });

  test('floorThreshold undefined preserves prior behavior', () => {
    const results: SearchResult[] = [makeResult({ slug: 'a', score: 0.3 })];
    applySalienceBoost(results, new Map([['default::a', 5]]), 'on');
    const factor = 1 + 0.15 * Math.log(6);
    expect(results[0].score).toBeCloseTo(0.3 * factor, 6);
  });
});

describe('applyRecencyBoost — floor gate (T6 IRON RULE)', () => {
  // Codex outside-voice + plan T6: applyRecencyBoost was the only modified
  // function in the original PR with ZERO new-param test coverage. This is
  // the regression test that closes the gap.
  test('weak result gated out from recency boost', () => {
    const now = new Date('2026-05-17').getTime();
    const yesterday = new Date(now - 86_400_000);
    const results: SearchResult[] = [
      makeResult({ slug: 'top', score: 1.0, source_id: undefined }),
      makeResult({ slug: 'weak', score: 0.3, source_id: undefined }),
    ];
    const dates = new Map([
      ['default::top', yesterday],
      ['default::weak', yesterday],
    ]);
    applyRecencyBoost(
      results,
      dates,
      'on',
      DEFAULT_RECENCY_DECAY,
      DEFAULT_FALLBACK,
      now,
      0.85,
    );
    // Top got boosted; weak unchanged at 0.3.
    expect(results[0].score).toBeGreaterThan(1.0);
    expect(results[1].score).toBe(0.3);
  });

  test('floorThreshold undefined preserves prior behavior', () => {
    const now = new Date('2026-05-17').getTime();
    const yesterday = new Date(now - 86_400_000);
    const results: SearchResult[] = [
      makeResult({ slug: 'weak', score: 0.3, source_id: undefined }),
    ];
    const dates = new Map([['default::weak', yesterday]]);
    applyRecencyBoost(
      results,
      dates,
      'on',
      DEFAULT_RECENCY_DECAY,
      DEFAULT_FALLBACK,
      now,
    );
    expect(results[0].score).toBeGreaterThan(0.3); // no gate, boost applies
  });
});

describe('runPostFusionStages — single-baseline composition (D6/T2)', () => {
  // Build a minimal engine stub that returns predictable boost inputs.
  function makeStubEngine(opts: {
    backlinks?: Map<string, number>;
    salience?: Map<string, number>;
    dates?: Map<string, Date>;
  }): { getBacklinkCounts: any; getSalienceScores: any; getEffectiveDates: any } {
    return {
      getBacklinkCounts: async () => opts.backlinks ?? new Map(),
      getSalienceScores: async () => opts.salience ?? new Map(),
      getEffectiveDates: async () => opts.dates ?? new Map(),
    };
  }

  test('threshold computed ONCE at entry; same gate decision regardless of which stages fire', async () => {
    // Pre-fix (per-stage recompute): backlink mutates `top`, so salience
    // sees a different threshold. With single-baseline, the same threshold
    // gates both stages — a result eligible for backlink is also eligible
    // for salience (and vice versa), regardless of stage order.
    const engine = makeStubEngine({
      backlinks: new Map([['top', 100], ['weak', 100]]),
      salience: new Map([['default::top', 10], ['default::weak', 10]]),
    });

    const resultsA: SearchResult[] = [
      makeResult({ slug: 'top', score: 1.0, source_id: undefined }),
      makeResult({ slug: 'weak', score: 0.3, source_id: undefined }),
    ];
    const optsA: PostFusionOpts = {
      applyBacklinks: true,
      salience: 'on',
      recency: 'off',
      floorRatio: 0.85,
    };
    await runPostFusionStages(engine as any, resultsA, optsA);

    // Run again with only salience enabled — same threshold should apply.
    const resultsB: SearchResult[] = [
      makeResult({ slug: 'top', score: 1.0, source_id: undefined }),
      makeResult({ slug: 'weak', score: 0.3, source_id: undefined }),
    ];
    const optsB: PostFusionOpts = {
      applyBacklinks: false,
      salience: 'on',
      recency: 'off',
      floorRatio: 0.85,
    };
    await runPostFusionStages(engine as any, resultsB, optsB);

    // In both runs, weak stayed at 0.3 (gated). Top got at least one boost.
    expect(resultsA[1].score).toBe(0.3);
    expect(resultsB[1].score).toBe(0.3);
    expect(resultsA[0].score).toBeGreaterThan(1.0);
    expect(resultsB[0].score).toBeGreaterThan(1.0);
  });

  test('floorRatio undefined: bit-for-bit prior behavior (no gate, weak gets boosted)', async () => {
    const engine = makeStubEngine({
      backlinks: new Map([['weak', 1000]]),
    });
    const results: SearchResult[] = [
      makeResult({ slug: 'top', score: 1.0, source_id: undefined }),
      makeResult({ slug: 'weak', score: 0.3, source_id: undefined }),
    ];
    const opts: PostFusionOpts = {
      applyBacklinks: true,
      salience: 'off',
      recency: 'off',
      // floorRatio intentionally omitted
    };
    await runPostFusionStages(engine as any, results, opts);
    expect(results[1].score).toBeGreaterThan(0.3); // weak got boosted, no gate
  });

  test('empty results: no-op, no divide-by-zero, no engine calls', async () => {
    let engineCalls = 0;
    const engine = {
      getBacklinkCounts: async () => { engineCalls++; return new Map(); },
      getSalienceScores: async () => { engineCalls++; return new Map(); },
      getEffectiveDates: async () => { engineCalls++; return new Map(); },
    };
    await runPostFusionStages(engine as any, [], {
      applyBacklinks: true,
      salience: 'on',
      recency: 'on',
      floorRatio: 0.85,
    });
    expect(engineCalls).toBe(0);
  });
});
