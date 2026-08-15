/**
 * v0.32.x search-lite \u2014 token budget enforcement.
 *
 * Pure module under test (no DB, no LLM). Confirms:
 *   - char/4 heuristic estimates correctly
 *   - greedy walk preserves caller ordering
 *   - meta accounting (used / kept / dropped) matches the actual cut
 *   - undefined / <=0 budget is a no-op
 *   - first-result-too-big keeps ONE truncated copy (WP2/T3 minKeep:1);
 *     GBRAIN_SEARCH_SALVAGE=off restores the strict [] (ENG-7)
 *   - packToBudget's strict [] edge is FROZEN for the memory-verb
 *     consumers (recall/entity/context_pack) \u2014 pinned directly (FOV-2)
 *
 * Lives in test/token-budget.test.ts to mirror existing search/* test naming.
 */

import { describe, test, expect } from 'bun:test';
import {
  enforceTokenBudget,
  estimateTokens,
  packToBudget,
  resultTokens,
  searchSalvageEnabled,
} from '../src/core/search/token-budget.ts';
import type { SearchResult } from '../src/core/types.ts';
import { withEnv } from './helpers/with-env.ts';

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

  // WP2/T3 (ENG-2/FOV-2): the strict [] expectation flipped to the minKeep
  // shape \u2014 the search wrapper never returns empty just because the top hit
  // is big; it keeps one truncated COPY and reports the cut honestly.
  test('first result exceeds budget alone \u2192 keeps ONE truncated copy (minKeep:1)', () => {
    const big = makeResult({ slug: 'big', title: 'a', chunk_text: 'x'.repeat(1000) });
    const small = makeResult({ slug: 'small', title: 'a', chunk_text: 'xxxx' });
    const { results: kept, meta } = enforceTokenBudget([big, small], 5);
    expect(kept).toHaveLength(1);
    expect(kept[0].slug).toBe('big');
    // title 'a' costs 1 token \u2192 4 tokens left \u2192 16 chars of chunk_text.
    expect(kept[0].chunk_text).toBe('x'.repeat(16));
    expect(resultTokens(kept[0])).toBeLessThanOrEqual(5);
    expect(meta.kept).toBe(1);
    expect(meta.dropped).toBe(1); // N-1
    expect(meta.truncated).toBe(true);
    expect(meta.used).toBeLessThanOrEqual(5);
  });

  test('minKeep truncates a COPY \u2014 the shared SearchResult is never mutated', () => {
    const big = makeResult({ slug: 'big', title: 'a', chunk_text: 'x'.repeat(1000) });
    const { results: kept } = enforceTokenBudget([big], 5);
    expect(kept[0]).not.toBe(big);
    expect(big.chunk_text).toBe('x'.repeat(1000)); // flows on to cache write + eval capture
    expect(kept[0].chunk_text.length).toBeLessThan(big.chunk_text.length);
  });

  test('budget below title-only cost \u2192 slices the title so used <= budget', () => {
    // Title alone costs 25 tokens (100 chars); budget 5 can't even fit it.
    // A hard cap that can be exceeded is not a cap: the title is sliced to
    // budget*4 chars (costs exactly `budget` under ceil(len/4)).
    const big = makeResult({ slug: 'big', title: 'T'.repeat(100), chunk_text: 'x'.repeat(1000) });
    const { results: kept, meta } = enforceTokenBudget([big], 5);
    expect(kept).toHaveLength(1);
    expect(kept[0].chunk_text).toBe('');
    expect(kept[0].title).toBe('T'.repeat(20));
    expect(meta.truncated).toBe(true);
    expect(meta.used).toBe(5);
    expect(meta.used).toBeLessThanOrEqual(meta.budget);
  });

  test('truncated flag absent on ordinary cuts and no-op passes', () => {
    const results = [
      makeResult({ slug: 'a', title: 'a', chunk_text: 'xxxx' }),
      makeResult({ slug: 'b', title: 'a', chunk_text: 'xxxx' }),
    ];
    expect(enforceTokenBudget(results, 2).meta.truncated).toBeUndefined();
    expect(enforceTokenBudget(results, undefined).meta.truncated).toBeUndefined();
  });
});

describe('GBRAIN_SEARCH_SALVAGE=off \u2014 strict budget wrapper restored (ENG-7)', () => {
  test('searchSalvageEnabled reads the env kill switch', async () => {
    await withEnv({ GBRAIN_SEARCH_SALVAGE: undefined }, () => {
      expect(searchSalvageEnabled()).toBe(true);
    });
    await withEnv({ GBRAIN_SEARCH_SALVAGE: 'off' }, () => {
      expect(searchSalvageEnabled()).toBe(false);
    });
  });

  test('first-result-exceeds returns [] again under the kill switch', async () => {
    await withEnv({ GBRAIN_SEARCH_SALVAGE: 'off' }, () => {
      const big = makeResult({ slug: 'big', title: 'a', chunk_text: 'x'.repeat(1000) });
      const small = makeResult({ slug: 'small', title: 'a', chunk_text: 'xxxx' });
      const { results: kept, meta } = enforceTokenBudget([big, small], 5);
      expect(kept).toHaveLength(0);
      expect(meta.dropped).toBe(2);
      expect(meta.kept).toBe(0);
      expect(meta.truncated).toBeUndefined();
    });
  });
});

// FOV-2 \u2014 direct packToBudget edge pins. The generic packer feeds the FROZEN
// memory-verb paths (recall operations.ts, entity, and context_pack); its
// strict first-item-exceeds [] edge must NOT inherit the search wrapper's
// minKeep salvage. No direct test existed at HEAD.
describe('packToBudget \u2014 frozen strict edge (memory-verb consumers)', () => {
  test('first item alone exceeds budget \u2192 [] (strict, regardless of salvage env)', async () => {
    // salvage ON \u2014 must not leak into the frozen packer edge.
    await withEnv({ GBRAIN_SEARCH_SALVAGE: undefined }, () => {
      const big = makeResult({ slug: 'big', title: 'a', chunk_text: 'x'.repeat(1000) });
      const { items, meta } = packToBudget([big], resultTokens, 5);
      expect(items).toHaveLength(0);
      expect(meta.kept).toBe(0);
      expect(meta.dropped).toBe(1);
      expect(meta.truncated).toBeUndefined();
    });
  });

  test('budget undefined / <= 0 passes items through unchanged', () => {
    const items = [makeResult({ slug: 'a' }), makeResult({ slug: 'b' })];
    expect(packToBudget(items, resultTokens, undefined).items).toHaveLength(2);
    expect(packToBudget(items, resultTokens, 0).items).toHaveLength(2);
    expect(packToBudget(items, resultTokens, -1).items).toHaveLength(2);
  });

  test('context_pack-shaped fixture: page-list packing keeps a contiguous prefix, strict on oversize head', () => {
    // Mirrors the context_pack cost model (operations.ts): pages costed by
    // `${title} ${slug}` via the generic <T> API.
    type PackPage = { title: string; slug: string };
    const cost = (pg: PackPage) => estimateTokens(`${pg.title} ${pg.slug}`);
    const pages: PackPage[] = [
      { title: 'Quarterly planning notes', slug: 'notes/quarterly-planning' }, // ~13 tokens
      { title: 'Acme seed memo', slug: 'deals/acme-seed' },                    // ~8 tokens
      { title: 'Widget series A', slug: 'deals/widget-series-a' },             // ~10 tokens
    ];
    // Budget fits the first two, not the third \u2192 contiguous prefix of 2.
    const budget = cost(pages[0]) + cost(pages[1]);
    const packed = packToBudget(pages, cost, budget);
    expect(packed.items.map((p) => p.slug)).toEqual([
      'notes/quarterly-planning',
      'deals/acme-seed',
    ]);
    expect(packed.meta.dropped).toBe(1);

    // Oversize head: the first page alone exceeds the budget \u2192 STRICT [];
    // context_pack's budget contract never fabricates a truncated page row.
    const tiny = packToBudget(pages, cost, 2);
    expect(tiny.items).toHaveLength(0);
    expect(tiny.meta.kept).toBe(0);
    expect(tiny.meta.dropped).toBe(3);
  });
});
