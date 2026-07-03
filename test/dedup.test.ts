import { describe, expect, test } from 'bun:test';
import { dedupResults } from '../src/core/search/dedup.ts';
import type { SearchResult } from '../src/core/types.ts';

function result(overrides: Partial<SearchResult>): SearchResult {
  return {
    slug: 'people/alice',
    page_id: 1,
    title: 'Alice',
    type: 'person',
    chunk_text: 'default chunk',
    chunk_source: 'compiled_truth',
    score: 1,
    stale: false,
    ...overrides,
  };
}

describe('dedupResults', () => {
  test('guarantees one compiled_truth chunk per page when higher-scoring timeline chunks crowd it out', () => {
    const results = dedupResults([
      result({
        slug: 'people/alice',
        page_id: 1,
        chunk_source: 'timeline',
        chunk_text: '2025 shipped alpha timeline milestone',
        score: 0.99,
      }),
      result({
        slug: 'people/alice',
        page_id: 1,
        chunk_source: 'timeline',
        chunk_text: '2024 joined team timeline milestone',
        score: 0.95,
      }),
      result({
        slug: 'people/alice',
        page_id: 1,
        chunk_source: 'compiled_truth',
        chunk_text: 'Alice leads the retrieval quality initiative.',
        score: 0.40,
      }),
      result({
        slug: 'concepts/search',
        page_id: 2,
        title: 'Search',
        type: 'concept',
        chunk_source: 'compiled_truth',
        chunk_text: 'Search blends recall and ranking.',
        score: 0.80,
      }),
    ]);

    const aliceChunks = results.filter((entry) => entry.slug === 'people/alice');
    expect(aliceChunks.length).toBe(2);
    expect(aliceChunks.some((entry) => entry.chunk_source === 'compiled_truth')).toBe(true);
  });

  test('re-sorts results after swapping in compiled_truth chunks', () => {
    const results = dedupResults([
      result({
        slug: 'people/alice',
        page_id: 1,
        chunk_source: 'timeline',
        chunk_text: 'alice latest timeline note',
        score: 0.99,
      }),
      result({
        slug: 'people/alice',
        page_id: 1,
        chunk_source: 'timeline',
        chunk_text: 'alice older timeline note',
        score: 0.95,
      }),
      result({
        slug: 'people/alice',
        page_id: 1,
        chunk_source: 'compiled_truth',
        chunk_text: 'Alice compiled truth should still be represented.',
        score: 0.40,
      }),
      result({
        slug: 'concepts/search',
        page_id: 2,
        title: 'Search',
        type: 'concept',
        chunk_source: 'compiled_truth',
        chunk_text: 'Search ranking should remain globally sorted.',
        score: 0.80,
      }),
      result({
        slug: 'concepts/retrieval',
        page_id: 3,
        title: 'Retrieval',
        type: 'concept',
        chunk_source: 'compiled_truth',
        chunk_text: 'Retrieval quality matters for recall.',
        score: 0.70,
      }),
    ]);

    expect(results.map((entry) => entry.score)).toEqual([0.99, 0.80, 0.70, 0.40]);
    expect(results[3]?.chunk_source).toBe('compiled_truth');
    expect(results[3]?.slug).toBe('people/alice');
  });

  test('deduplicates CJK-heavy near duplicates with character bigrams', () => {
    const results = dedupResults([
      result({
        slug: 'concepts/rebellion-a',
        page_id: 10,
        title: 'Rebellion A',
        chunk_text: '레벨리온은 한국어 검색 품질을 검증한다.',
        score: 1,
      }),
      result({
        slug: 'concepts/rebellion-b',
        page_id: 11,
        title: 'Rebellion B',
        chunk_text: '레벨리온 한국어 검색 품질을 검증한다.',
        score: 0.95,
      }),
      result({
        slug: 'concepts/other',
        page_id: 12,
        title: 'Other',
        chunk_text: 'Completely different retrieval evidence.',
        score: 0.7,
      }),
    ]);

    expect(results.map((entry) => entry.slug)).toEqual([
      'concepts/rebellion-a',
      'concepts/other',
    ]);
  });
});
