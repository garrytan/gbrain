import { afterEach, describe, expect, test } from 'bun:test';
import { hybridSearch, hybridSearchWithMeta } from '../src/core/search/hybrid.ts';
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

  test('uses vector scores as a narrow tie-breaker after RRF fusion', async () => {
    setEmbeddingProviderForTests({
      capability: {
        available: true,
        mode: 'local',
        implementation: 'test-local',
        model: 'test-local-v1',
        dimensions: 3,
      },
      embedBatch: async () => [new Float32Array([1, 0, 0])],
    });

    const engine = {
      searchKeyword: async () => [
        makeResult({
          slug: 'concepts/alpha-keyword',
          page_id: 101,
          title: 'Alpha Keyword',
          type: 'concept',
          chunk_text: 'alpha keyword match without semantic confidence',
          score: 1,
        }),
      ],
      searchVector: async () => [
        makeResult({
          slug: 'concepts/vector-high',
          page_id: 102,
          title: 'Vector High',
          type: 'person',
          chunk_text: 'semantic neighbor with strong vector score',
          score: 0.95,
        }),
        makeResult({
          slug: 'concepts/vector-low',
          page_id: 103,
          title: 'Vector Low',
          type: 'project',
          chunk_text: 'semantic neighbor with weak vector score',
          score: 0.1,
        }),
      ],
    } as Pick<BrainEngine, 'searchKeyword' | 'searchVector'> as BrainEngine;

    const results = await hybridSearch(engine, 'semantic confidence', { limit: 3 });

    expect(results.map((entry) => entry.slug)).toEqual([
      'concepts/vector-high',
      'concepts/alpha-keyword',
      'concepts/vector-low',
    ]);
  });

  test('does not let a lower-ranked high-confidence vector neighbor outrank the top keyword-only result', async () => {
    setEmbeddingProviderForTests({
      capability: {
        available: true,
        mode: 'local',
        implementation: 'test-local',
        model: 'test-local-v1',
        dimensions: 3,
      },
      embedBatch: async () => [new Float32Array([1, 0, 0])],
    });

    const vectorResults = [
      makeResult({
        slug: 'concepts/vector-top',
        page_id: 200,
        title: 'Vector Top',
        type: 'person',
        chunk_text: 'top vector neighbor with weak semantic confidence',
        score: 0.01,
      }),
      makeResult({
        slug: 'concepts/vector-middle',
        page_id: 201,
        title: 'Vector Middle',
        type: 'project',
        chunk_text: 'middle vector neighbor with weak semantic confidence',
        score: 0.01,
      }),
      makeResult({
        slug: 'concepts/vector-lower-high-confidence',
        page_id: 202,
        title: 'Vector Lower High Confidence',
        type: 'company',
        chunk_text: 'lower vector neighbor with strong semantic confidence',
        score: 0.95,
      }),
    ];

    const engine = {
      searchKeyword: async () => [
        makeResult({
          slug: 'concepts/exact-keyword',
          page_id: 999,
          title: 'Exact Keyword',
          type: 'concept',
          chunk_text: 'exact keyword result should stay ahead of deep vector neighbors',
          score: 1,
        }),
      ],
      searchVector: async () => vectorResults,
    } as Pick<BrainEngine, 'searchKeyword' | 'searchVector'> as BrainEngine;

    const results = await hybridSearch(engine, 'exact keyword', { limit: 10 });
    const slugs = results.map((entry) => entry.slug);

    expect(slugs.indexOf('concepts/exact-keyword')).toBeLessThan(
      slugs.indexOf('concepts/vector-lower-high-confidence'),
    );
  });
});

describe('hybridSearchWithMeta expansion failure flag (C-20)', () => {
  const disabledProvider = {
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
  } as const;

  function keywordOnlyEngine(): BrainEngine {
    return {
      searchKeyword: async () => [makeResult()],
      searchVector: async () => [],
    } as Pick<BrainEngine, 'searchKeyword' | 'searchVector'> as BrainEngine;
  }

  test('flags expansion_failed when the expansion function throws', async () => {
    setEmbeddingProviderForTests(disabledProvider as any);
    const { results, expansion_failed } = await hybridSearchWithMeta(keywordOnlyEngine(), 'context', {
      expansion: true,
      expandFn: async () => {
        throw new Error('rewrite runner unavailable');
      },
    });
    expect(expansion_failed).toBe(true);
    expect(results.length).toBeGreaterThan(0);
  });

  test('does not flag expansion_failed when expansion succeeds', async () => {
    setEmbeddingProviderForTests(disabledProvider as any);
    const { expansion_failed } = await hybridSearchWithMeta(keywordOnlyEngine(), 'context', {
      expansion: true,
      expandFn: async () => ['context compounding'],
    });
    expect(expansion_failed).toBe(false);
  });

  test('does not flag expansion_failed when expansion is disabled', async () => {
    setEmbeddingProviderForTests(disabledProvider as any);
    const { expansion_failed } = await hybridSearchWithMeta(keywordOnlyEngine(), 'context', {});
    expect(expansion_failed).toBe(false);
  });
});
