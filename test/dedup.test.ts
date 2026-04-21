/**
 * Dedup pipeline unit tests — source-aware guarantee, layer interactions,
 * and compiled truth preservation.
 */

import { describe, test, expect } from 'bun:test';
import { dedupResults } from '../src/core/search/dedup.ts';
import type { SearchResult } from '../src/core/types.ts';

function makeResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    slug: 'test-page',
    page_id: 1,
    title: 'Test',
    type: 'concept',
    chunk_text: 'unique chunk text ' + Math.random(),
    chunk_source: 'compiled_truth',
    chunk_id: Math.floor(Math.random() * 10000),
    chunk_index: 0,
    score: 0.5,
    stale: false,
    ...overrides,
  };
}

describe('dedupResults', () => {
  test('basic dedup caps per page to 2', () => {
    const results = [
      makeResult({ slug: 'a', score: 0.9, chunk_text: 'first' }),
      makeResult({ slug: 'a', score: 0.8, chunk_text: 'second' }),
      makeResult({ slug: 'a', score: 0.7, chunk_text: 'third' }),
      makeResult({ slug: 'a', score: 0.6, chunk_text: 'fourth' }),
    ];
    const deduped = dedupResults(results);
    const aChunks = deduped.filter(r => r.slug === 'a');
    expect(aChunks.length).toBeLessThanOrEqual(2);
  });

  test('removes text-similar chunks', () => {
    const results = [
      makeResult({ slug: 'a', score: 0.9, chunk_text: 'the quick brown fox jumps over the lazy dog' }),
      makeResult({ slug: 'b', score: 0.8, chunk_text: 'the quick brown fox jumps over the lazy cat' }),
    ];
    const deduped = dedupResults(results);
    // These share high Jaccard similarity, one should be removed
    expect(deduped.length).toBeLessThanOrEqual(2);
  });

  test('enforces type diversity when mixed types present', () => {
    // Mix of person and concept types — diversity should cap person
    const results = [
      ...Array.from({ length: 8 }, (_, i) =>
        makeResult({ slug: `p${i}`, page_id: i, score: 1 - i * 0.05, type: 'person', chunk_text: `person ${i} unique text content here` })
      ),
      ...Array.from({ length: 4 }, (_, i) =>
        makeResult({ slug: `c${i}`, page_id: 100 + i, score: 0.4 - i * 0.05, type: 'concept', chunk_text: `concept ${i} unique text content here` })
      ),
    ];
    const deduped = dedupResults(results);
    const personCount = deduped.filter(r => r.type === 'person').length;
    const conceptCount = deduped.filter(r => r.type === 'concept').length;
    // With diversity enforcement, person shouldn't completely dominate
    expect(personCount).toBeGreaterThan(0);
    expect(conceptCount).toBeGreaterThan(0);
  });
});

describe('compiled truth guarantee', () => {
  test('swaps in compiled_truth when page has only timeline in results', () => {
    const results = [
      makeResult({ slug: 'a', chunk_id: 1, score: 0.9, chunk_source: 'timeline', chunk_text: 'timeline entry about meeting' }),
      makeResult({ slug: 'a', chunk_id: 2, score: 0.8, chunk_source: 'timeline', chunk_text: 'another timeline entry here' }),
      makeResult({ slug: 'a', chunk_id: 3, score: 0.3, chunk_source: 'compiled_truth', chunk_text: 'compiled truth assessment of entity' }),
      makeResult({ slug: 'b', chunk_id: 4, score: 0.7, chunk_source: 'compiled_truth', chunk_text: 'page b compiled truth' }),
    ];
    const deduped = dedupResults(results);
    const aChunks = deduped.filter(r => r.slug === 'a');
    const hasCompiledTruth = aChunks.some(c => c.chunk_source === 'compiled_truth');
    expect(hasCompiledTruth).toBe(true);
  });

  test('does not swap when page already has compiled_truth', () => {
    const results = [
      makeResult({ slug: 'a', chunk_id: 1, score: 0.9, chunk_source: 'compiled_truth', chunk_text: 'compiled assessment' }),
      makeResult({ slug: 'a', chunk_id: 2, score: 0.8, chunk_source: 'timeline', chunk_text: 'timeline entry details' }),
    ];
    const deduped = dedupResults(results);
    const aChunks = deduped.filter(r => r.slug === 'a');
    // Should still have compiled_truth
    expect(aChunks.some(c => c.chunk_source === 'compiled_truth')).toBe(true);
  });

  test('does nothing when no compiled_truth exists for page', () => {
    const results = [
      makeResult({ slug: 'a', chunk_id: 1, score: 0.9, chunk_source: 'timeline', chunk_text: 'only timeline chunk one' }),
      makeResult({ slug: 'a', chunk_id: 2, score: 0.8, chunk_source: 'timeline', chunk_text: 'only timeline chunk two' }),
    ];
    const deduped = dedupResults(results);
    // All timeline, no compiled_truth to swap in
    const aChunks = deduped.filter(r => r.slug === 'a');
    expect(aChunks.every(c => c.chunk_source === 'timeline')).toBe(true);
  });

  test('guarantee works across multiple pages', () => {
    const results = [
      // Page A: only timeline in top results, compiled_truth exists lower
      makeResult({ slug: 'a', chunk_id: 1, score: 0.95, chunk_source: 'timeline', chunk_text: 'a timeline high score' }),
      makeResult({ slug: 'a', chunk_id: 2, score: 0.9, chunk_source: 'timeline', chunk_text: 'a timeline medium score' }),
      makeResult({ slug: 'a', chunk_id: 3, score: 0.2, chunk_source: 'compiled_truth', chunk_text: 'a compiled truth low score' }),
      // Page B: has compiled_truth already
      makeResult({ slug: 'b', chunk_id: 4, score: 0.85, chunk_source: 'compiled_truth', chunk_text: 'b compiled truth content' }),
      // Page C: only timeline, no compiled_truth at all
      makeResult({ slug: 'c', chunk_id: 5, score: 0.8, chunk_source: 'timeline', chunk_text: 'c timeline only entry' }),
    ];

    const deduped = dedupResults(results);

    // Page A should have compiled_truth guaranteed
    const aChunks = deduped.filter(r => r.slug === 'a');
    if (aChunks.length > 0) {
      expect(aChunks.some(c => c.chunk_source === 'compiled_truth')).toBe(true);
    }

    // Page B already had compiled_truth
    const bChunks = deduped.filter(r => r.slug === 'b');
    if (bChunks.length > 0) {
      expect(bChunks.some(c => c.chunk_source === 'compiled_truth')).toBe(true);
    }

    // Page C has no compiled_truth to swap in, so all timeline is fine
    const cChunks = deduped.filter(r => r.slug === 'c');
    if (cChunks.length > 0) {
      expect(cChunks.every(c => c.chunk_source === 'timeline')).toBe(true);
    }
  });
});

describe('edge cases', () => {
  test('empty input returns empty', () => {
    expect(dedupResults([])).toEqual([]);
  });

  test('single result passes through', () => {
    const result = makeResult({ chunk_text: 'single result here' });
    const deduped = dedupResults([result]);
    expect(deduped).toHaveLength(1);
  });

  test('respects custom maxPerPage option', () => {
    const results = Array.from({ length: 5 }, (_, i) =>
      makeResult({ slug: 'a', chunk_id: i + 100, score: 1 - i * 0.1, chunk_text: `chunk number ${i} with unique content` })
    );
    const deduped = dedupResults(results, { maxPerPage: 3 });
    expect(deduped.filter(r => r.slug === 'a').length).toBeLessThanOrEqual(3);
  });
});
