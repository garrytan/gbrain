/**
 * v0.32.x search-lite \u2014 intent \u2192 weight adjustment tests.
 *
 * Pure module under test (no DB). Confirms:
 *   - weightsForIntent returns the expected per-intent factors
 *   - effectiveRrfK scales correctly with the weight
 *   - applyExactMatchBoost only fires on exact slug/title matches
 *   - general intent is a no-op (preserves pre-v0.32 behavior)
 */

import { describe, test, expect } from 'bun:test';
import {
  weightsForIntent,
  effectiveRrfK,
  applyExactMatchBoost,
} from '../src/core/search/intent-weights.ts';
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

describe('weightsForIntent', () => {
  test('general intent is the identity', () => {
    const w = weightsForIntent('general');
    expect(w.keywordWeight).toBe(1.0);
    expect(w.vectorWeight).toBe(1.0);
    expect(w.suggestedRecency).toBe(null);
    expect(w.exactMatchBoost).toBe(1.0);
  });

  test('entity intent boosts keyword + exact match', () => {
    const w = weightsForIntent('entity');
    expect(w.keywordWeight).toBeGreaterThan(1.0);
    expect(w.exactMatchBoost).toBeGreaterThan(1.0);
    expect(w.suggestedRecency).toBe(null);
  });

  test('temporal intent suggests recency=on', () => {
    const w = weightsForIntent('temporal');
    expect(w.suggestedRecency).toBe('on');
  });

  test('event intent boosts keyword (rare named entities)', () => {
    const w = weightsForIntent('event');
    expect(w.keywordWeight).toBeGreaterThan(1.0);
    expect(w.suggestedRecency).toBe('on');
  });
});

describe('effectiveRrfK', () => {
  test('weight=1.0 returns base k unchanged', () => {
    expect(effectiveRrfK(60, 1.0)).toBe(60);
  });

  test('weight > 1 lowers k (stronger top-rank contribution)', () => {
    expect(effectiveRrfK(60, 1.2)).toBeLessThan(60);
    expect(effectiveRrfK(60, 1.2)).toBe(50);
  });

  test('weight <= 0 returns base k (safety)', () => {
    expect(effectiveRrfK(60, 0)).toBe(60);
    expect(effectiveRrfK(60, -1)).toBe(60);
  });
});

describe('applyExactMatchBoost', () => {
  test('boost=1.0 is a no-op', () => {
    const results = [makeResult({ slug: 'foo', score: 1.0 })];
    applyExactMatchBoost(results, 'foo', weightsForIntent('general'));
    expect(results[0].score).toBe(1.0);
  });

  test('exact slug match gets boosted (entity intent)', () => {
    const results = [
      makeResult({ slug: 'garry-tan', score: 1.0, title: 'Garry Tan' }),
      makeResult({ slug: 'someone-else', score: 1.0, title: 'Someone Else' }),
    ];
    applyExactMatchBoost(results, 'garry-tan', weightsForIntent('entity'));
    // First result has slug=query \u2192 boosted; second is unchanged.
    expect(results[0].score).toBeGreaterThan(1.0);
    expect(results[1].score).toBe(1.0);
  });

  test('query with spaces matches kebab slug ("garry tan" \u2192 "garry-tan")', () => {
    const results = [makeResult({ slug: 'garry-tan', score: 1.0 })];
    applyExactMatchBoost(results, 'garry tan', weightsForIntent('entity'));
    expect(results[0].score).toBeGreaterThan(1.0);
  });

  test('exact title match (case-insensitive) gets boosted', () => {
    const results = [makeResult({ slug: 'random-slug', title: 'Garry Tan', score: 1.0 })];
    applyExactMatchBoost(results, 'GARRY TAN', weightsForIntent('entity'));
    expect(results[0].score).toBeGreaterThan(1.0);
  });

  test('partial / substring match does NOT trigger boost', () => {
    const results = [makeResult({ slug: 'garry-tan', title: 'Garry Tan', score: 1.0 })];
    applyExactMatchBoost(results, 'garry', weightsForIntent('entity'));
    expect(results[0].score).toBe(1.0);
  });

  test('namespaced slug matches via suffix ("people/garry-tan" + query "garry-tan")', () => {
    const results = [makeResult({ slug: 'people/garry-tan', score: 1.0 })];
    applyExactMatchBoost(results, 'garry-tan', weightsForIntent('entity'));
    expect(results[0].score).toBeGreaterThan(1.0);
  });
});
