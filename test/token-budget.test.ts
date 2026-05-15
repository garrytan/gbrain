/**
 * v0.32.x search-lite \u2014 token budget enforcement.
 *
 * Pure module under test (no DB, no LLM). Confirms:
 *   - char/4 heuristic estimates correctly
 *   - greedy walk preserves caller ordering
 *   - meta accounting (used / kept / dropped) matches the actual cut
 *   - undefined / <=0 budget is a no-op
 *   - first-result-too-big returns empty list
 *
 * Lives in test/token-budget.test.ts to mirror existing search/* test naming.
 */

import { describe, test, expect } from 'bun:test';
import { enforceTokenBudget, estimateTokens, resultTokens } from '../src/core/search/token-budget.ts';
import type { SearchResult } from '../src/core/types.ts';

function makeResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    slug: 'test-page',
    page_id: 1,
    title: 'Test Title',
    type: 'concept',
    chunk_text: 'test chunk text',
    chunk_source: 'compiled_truth',
    chunk_id: 1,
    chunk_index: 0,
    score: 1.0,
    stale: false,
    ...overrides,
  };
}

describe('estimateTokens', () => {
  test('empty / nullish strings cost 0 tokens', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens(undefined)).toBe(0);
    expect(estimateTokens(null)).toBe(0);
  });

  test('rounds up so a single char still costs 1 token', () => {
    expect(estimateTokens('a')).toBe(1);
    expect(estimateTokens('abc')).toBe(1);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });

  test('scales linearly at ~4 chars / token', () => {
    // 100 chars \u2192 25 tokens
    expect(estimateTokens('x'.repeat(100))).toBe(25);
    // 401 chars \u2192 ceil(401/4) = 101
    expect(estimateTokens('x'.repeat(401))).toBe(101);
  });
});

describe('resultTokens', () => {
  test('sums title + chunk_text', () => {
    const r = makeResult({ title: 'abcd', chunk_text: 'efgh' });  // 1 + 1 = 2
    expect(resultTokens(r)).toBe(2);
  });
});

describe('enforceTokenBudget', () => {
  test('undefined budget is a no-op', () => {
    const results = [makeResult({ slug: 'a' }), makeResult({ slug: 'b' })];
    const { results: kept, meta } = enforceTokenBudget(results, undefined);
    expect(kept).toHaveLength(2);
    expect(meta.dropped).toBe(0);
    expect(meta.kept).toBe(2);
    expect(meta.budget).toBe(0);  // safe-budget normalization
  });

  test('zero / negative budget is a no-op', () => {
    const results = [makeResult({ slug: 'a' })];
    expect(enforceTokenBudget(results, 0).results).toHaveLength(1);
    expect(enforceTokenBudget(results, -5).results).toHaveLength(1);
  });

  test('empty input returns empty', () => {
    const { results, meta } = enforceTokenBudget([], 100);
    expect(results).toHaveLength(0);
    expect(meta.kept).toBe(0);
    expect(meta.dropped).toBe(0);
  });

  test('greedy top-down: stops as soon as cumulative cost would exceed budget', () => {
    // Each result: title 'a' (1 tok) + chunk_text 'xxxx' (1 tok) = 2 tokens each
    const results = [
      makeResult({ slug: 'a', title: 'a', chunk_text: 'xxxx' }),
      makeResult({ slug: 'b', title: 'a', chunk_text: 'xxxx' }),
      makeResult({ slug: 'c', title: 'a', chunk_text: 'xxxx' }),
      makeResult({ slug: 'd', title: 'a', chunk_text: 'xxxx' }),
    ];
    // Budget 5 \u2192 fits 2 results (cost 2+2=4); a 3rd would push to 6.
    const { results: kept, meta } = enforceTokenBudget(results, 5);
    expect(kept).toHaveLength(2);
    expect(kept.map(r => r.slug)).toEqual(['a', 'b']);
    expect(meta.used).toBe(4);
    expect(meta.dropped).toBe(2);
    expect(meta.kept).toBe(2);
    expect(meta.budget).toBe(5);
  });

  test('preserves caller ordering (never re-ranks)', () => {
    const results = [
      makeResult({ slug: 'low-score', score: 0.1, title: 'a', chunk_text: 'xxxx' }),
      makeResult({ slug: 'high-score', score: 0.9, title: 'a', chunk_text: 'xxxx' }),
    ];
    const { results: kept } = enforceTokenBudget(results, 2);
    // 2 tokens fits exactly one result; budget pass should keep the FIRST,
    // even though it has a worse score \u2014 ordering is caller's contract.
    expect(kept).toHaveLength(1);
    expect(kept[0].slug).toBe('low-score');
  });

  test('first result exceeds budget alone \u2192 returns empty', () => {
    const big = makeResult({ slug: 'big', title: 'a', chunk_text: 'x'.repeat(1000) });
    const small = makeResult({ slug: 'small', title: 'a', chunk_text: 'xxxx' });
    const { results: kept, meta } = enforceTokenBudget([big, small], 5);
    expect(kept).toHaveLength(0);
    expect(meta.dropped).toBe(2);
  });
});
