/**
 * RRF fusion key is source-aware (federation hardening).
 *
 * Pre-fix the RRF/dedup key was `slug:chunk_id`, which collapsed two
 * same-slug pages living in different federated sources into one fusion
 * entry — a cross-source recall bug. The key is now
 * `(source_id, slug, chunk_id)`, matching `dedup.ts:pageKey`'s composite
 * discipline at chunk granularity. These tests pin that behavior for both
 * `rrfFusion` and `rrfFusionWeighted` and confirm single-source ranking is
 * unchanged.
 */

import { describe, test, expect } from 'bun:test';
import { rrfFusion, rrfFusionWeighted } from '../src/core/search/hybrid.ts';
import type { SearchResult } from '../src/core/types.ts';

function makeResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    slug: 'test-page',
    page_id: 1,
    title: 'Test',
    type: 'concept',
    chunk_text: 'unique chunk text',
    chunk_source: 'timeline', // avoid compiled_truth 2x boost noise
    chunk_id: 1,
    chunk_index: 0,
    score: 0.5,
    stale: false,
    ...overrides,
  };
}

describe('RRF key is source-aware', () => {
  test('same slug + chunk_id in DIFFERENT sources do NOT collapse', () => {
    const a = makeResult({ slug: 'people/alice', chunk_id: 1, source_id: 'team-a', chunk_text: 'x' });
    const b = makeResult({ slug: 'people/alice', chunk_id: 1, source_id: 'team-b', chunk_text: 'y' });
    const out = rrfFusion([[a, b]], 60);
    expect(out.length).toBe(2);
    expect(new Set(out.map(r => r.source_id))).toEqual(new Set(['team-a', 'team-b']));
  });

  test('same slug + chunk_id + SAME source DO collapse (reinforce across lists)', () => {
    const a = makeResult({ slug: 'people/alice', chunk_id: 1, source_id: 'team-a', chunk_text: 'x' });
    const b = makeResult({ slug: 'people/alice', chunk_id: 1, source_id: 'team-a', chunk_text: 'x' });
    const out = rrfFusion([[a], [b]], 60);
    expect(out.length).toBe(1);
  });

  test('single-source (no source_id → "default") ranking unchanged', () => {
    const a = makeResult({ slug: 'a', chunk_id: 1, chunk_text: 'aaa' });
    const b = makeResult({ slug: 'b', chunk_id: 2, chunk_text: 'bbb' });
    const out = rrfFusion([[a, b]], 60);
    expect(out.length).toBe(2);
    expect(out[0].slug).toBe('a'); // rank-0 wins, as before the key change
  });

  test('chunkless rows (null chunk_id) stay distinct per source via text prefix', () => {
    const a = makeResult({ slug: 'people/alice', chunk_id: undefined as unknown as number, source_id: 'team-a', chunk_text: 'alice page' });
    const b = makeResult({ slug: 'people/alice', chunk_id: undefined as unknown as number, source_id: 'team-b', chunk_text: 'alice page' });
    const out = rrfFusion([[a, b]], 60);
    expect(out.length).toBe(2);
  });

  test('weighted RRF is also source-aware', () => {
    const a = makeResult({ slug: 'people/alice', chunk_id: 1, source_id: 'team-a' });
    const b = makeResult({ slug: 'people/alice', chunk_id: 1, source_id: 'team-b' });
    const out = rrfFusionWeighted([{ list: [a, b], k: 60 }]);
    expect(out.length).toBe(2);
  });
});

describe('#3783 — keyword_hit OR-propagation through fusion', () => {
  test('rrfFusionWeighted: vector copy seen FIRST, keyword copy merges later → fused row keeps the flag', () => {
    const vectorCopy = makeResult({ slug: 'a', chunk_id: 1, source_id: 'default' });
    const keywordCopy = makeResult({ slug: 'a', chunk_id: 1, source_id: 'default', keyword_hit: true });
    const out = rrfFusionWeighted([
      { list: [vectorCopy], k: 60 },
      { list: [keywordCopy], k: 60 },
    ]);
    expect(out.length).toBe(1);
    expect(out[0].keyword_hit).toBe(true);
  });

  test('rrfFusionWeighted: keyword copy seen FIRST also keeps the flag', () => {
    const keywordCopy = makeResult({ slug: 'a', chunk_id: 1, keyword_hit: true });
    const vectorCopy = makeResult({ slug: 'a', chunk_id: 1 });
    const out = rrfFusionWeighted([
      { list: [keywordCopy], k: 60 },
      { list: [vectorCopy], k: 60 },
    ]);
    expect(out.length).toBe(1);
    expect(out[0].keyword_hit).toBe(true);
  });

  test('rrfFusionWeighted: a vector-only row does NOT gain the flag', () => {
    const vectorOnly = makeResult({ slug: 'v', chunk_id: 2 });
    const out = rrfFusionWeighted([{ list: [vectorOnly], k: 60 }]);
    expect(out[0].keyword_hit).not.toBe(true);
  });

  test('rrfFusion: OR-propagation across plain lists too', () => {
    const vectorCopy = makeResult({ slug: 'a', chunk_id: 1 });
    const keywordCopy = makeResult({ slug: 'a', chunk_id: 1, keyword_hit: true });
    const out = rrfFusion([[vectorCopy], [keywordCopy]], 60);
    expect(out.length).toBe(1);
    expect(out[0].keyword_hit).toBe(true);
  });

  test('fusion does not mutate the input list rows (flag lands on the fused copy)', () => {
    const vectorCopy = makeResult({ slug: 'a', chunk_id: 1 });
    const keywordCopy = makeResult({ slug: 'a', chunk_id: 1, keyword_hit: true });
    rrfFusionWeighted([{ list: [vectorCopy], k: 60 }, { list: [keywordCopy], k: 60 }]);
    expect(vectorCopy.keyword_hit).toBeUndefined();
  });
});
