import { afterEach, describe, expect, test } from 'bun:test';
import { hybridSearch } from '../src/core/search/hybrid.ts';
import { resetEmbeddingProviderForTests, setEmbeddingProviderForTests } from '../src/core/embedding.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { SearchResult } from '../src/core/types.ts';

function makeResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    slug: 'concepts/hybrid',
    page_id: 1,
    title: 'Hybrid',
    type: 'concept',
    chunk_text: 'hybrid search result',
    chunk_source: 'compiled_truth',
    score: 1,
    stale: false,
    ...overrides,
  };
}

afterEach(() => {
  resetEmbeddingProviderForTests();
});

describe('hybridSearch', () => {
  test('applies source-aware ranking to keyword-only fallback results', async () => {
    setEmbeddingProviderForTests({
      capability: {
        available: false,
        mode: 'none',
        implementation: 'none',
        model: null,
        dimensions: null,
        reason: 'test provider disabled',
      },
      embedBatch: async () => {
        throw new Error('test provider disabled');
      },
    });

    const seenLimits: number[] = [];
    const engine = {
      searchKeyword: async (_query: string, opts?: { limit?: number }) => {
        seenLimits.push(opts?.limit ?? 0);
        return [
          makeResult({ slug: 'daily/2026-04-29', score: 1, chunk_text: 'daily context note' }),
          makeResult({ slug: 'daily/2026-04-30', score: 0.99, chunk_text: 'daily context note two' }),
          makeResult({ slug: 'originals/context-compounding', score: 0.7, chunk_text: 'curated context thesis' }),
        ].slice(0, opts?.limit);
      },
      searchVector: async () => [],
    } as Pick<BrainEngine, 'searchKeyword' | 'searchVector'> as BrainEngine;

    const results = await hybridSearch(engine, 'context compounding', { limit: 1 });

    expect(seenLimits).toEqual([50]);
    expect(results.map((entry) => entry.slug)).toEqual([
      'originals/context-compounding',
    ]);
  });

  test('ranks before deduplication so curated duplicate text can survive', async () => {
    setEmbeddingProviderForTests({
      capability: {
        available: false,
        mode: 'none',
        implementation: 'none',
        model: null,
        dimensions: null,
        reason: 'test provider disabled',
      },
      embedBatch: async () => {
        throw new Error('test provider disabled');
      },
    });

    const engine = {
      searchKeyword: async () => [
        makeResult({ slug: 'daily/2026-04-29', score: 1, chunk_text: 'shared context note' }),
        makeResult({ slug: 'originals/context-compounding', score: 0.82, chunk_text: 'shared context note' }),
      ],
      searchVector: async () => [],
    } as Pick<BrainEngine, 'searchKeyword' | 'searchVector'> as BrainEngine;

    const results = await hybridSearch(engine, 'context compounding', { limit: 5 });

    expect(results.map((entry) => entry.slug)).toEqual(['originals/context-compounding']);
  });

  test('deduplicates expanded query variants before embedding and vector search', async () => {
    const embeddedQueries: string[] = [];
    const vectorCalls: Float32Array[] = [];

    setEmbeddingProviderForTests({
      capability: {
        available: true,
        mode: 'local',
        implementation: 'test-local',
        model: 'test-local-v1',
        dimensions: 3,
      },
      embedBatch: async (texts: string[]) => {
        embeddedQueries.push(...texts);
        return texts.map((text, index) => new Float32Array([text.length, index + 1, 1]));
      },
    });

    const engine = {
      searchKeyword: async () => [makeResult()],
      searchVector: async (embedding: Float32Array) => {
        vectorCalls.push(embedding);
        return [];
      },
    } as Pick<BrainEngine, 'searchKeyword' | 'searchVector'> as BrainEngine;

    const results = await hybridSearch(engine, 'hybrid search', {
      limit: 5,
      expansion: true,
      expandFn: async () => ['hybrid search', 'HYBRID SEARCH', 'hybrid search alternatives'],
    });

    expect(embeddedQueries).toEqual(['hybrid search', 'hybrid search alternatives']);
    expect(vectorCalls).toHaveLength(2);
    expect(results.map((entry) => entry.slug)).toEqual(['concepts/hybrid']);
  });
});
