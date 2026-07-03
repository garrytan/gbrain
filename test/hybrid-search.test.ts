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

  test('collapses vector expansion variants by max rank instead of summing repeated hits', async () => {
    setEmbeddingProviderForTests({
      capability: {
        available: true,
        mode: 'local',
        implementation: 'test-local',
        model: 'test-local-v1',
        dimensions: 3,
      },
      embedBatch: async (texts: string[]) => texts.map((_, index) => new Float32Array([index + 1, 0, 0])),
    });

    let vectorCall = 0;
    const engine = {
      searchKeyword: async () => [],
      searchVector: async () => {
        const call = vectorCall;
        vectorCall += 1;
        return [
          makeResult({
            slug: `concepts/vector-top-${call}`,
            page_id: 300 + call,
            title: `Vector Top ${call}`,
            chunk_text: `top semantic variant ${call}`,
            score: 0.7,
          }),
          makeResult({
            slug: 'concepts/repeated-vector',
            page_id: 399,
            title: 'Repeated Vector',
            chunk_text: 'same semantic neighbor repeated in every expansion',
            score: 0.9,
          }),
        ];
      },
    } as Pick<BrainEngine, 'searchKeyword' | 'searchVector'> as BrainEngine;

    const results = await hybridSearch(engine, 'semantic route', {
      limit: 5,
      expansion: true,
      expandFn: async () => ['semantic route variant a', 'semantic route variant b'],
    });

    const slugs = results.map((entry) => entry.slug);
    expect(vectorCall).toBe(3);
    expect(slugs.slice(0, 3)).toEqual([
      'concepts/vector-top-0',
      'concepts/vector-top-1',
      'concepts/vector-top-2',
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

  test('RRF keeps distinct chunks that share slug and first 50 text characters', async () => {
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

    const sharedPrefix = 'x'.repeat(50);
    const engine = {
      searchKeyword: async () => [],
      searchVector: async () => [
        makeResult({
          slug: 'systems/mbrain',
          page_id: 42,
          chunk_index: 0,
          chunk_source: 'compiled_truth',
          chunk_text: `${sharedPrefix} canonical projection audit lineage`,
        }),
        makeResult({
          slug: 'systems/mbrain',
          page_id: 42,
          chunk_index: 1,
          chunk_source: 'timeline',
          chunk_text: `${sharedPrefix} historical conflict resolution note`,
        }),
      ],
    } as Pick<BrainEngine, 'searchKeyword' | 'searchVector'> as BrainEngine;

    const results = await hybridSearch(engine, 'assertion audit', { limit: 5 });

    expect(results.map((entry) => entry.chunk_source)).toEqual([
      'compiled_truth',
      'timeline',
    ]);
    expect(results.map((entry) => entry.chunk_text)).toHaveLength(2);
  });

  test('RRF fuses the same chunk returned as keyword snippet and vector full text', async () => {
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

    const longChunk = `${'semantic audit '.repeat(35)}stable chunk identity`;
    const engine = {
      searchKeyword: async () => [
        makeResult({
          slug: 'systems/mbrain',
          page_id: 42,
          chunk_index: 7,
          chunk_source: 'compiled_truth',
          chunk_text: `${longChunk.slice(0, 320)}...`,
          score: 1,
        }),
      ],
      searchVector: async () => [
        makeResult({
          slug: 'scratch/vector-only',
          page_id: 99,
          chunk_index: 0,
          chunk_source: 'compiled_truth',
          chunk_text: 'vector only competitor',
          score: 1,
        }),
        makeResult({
          slug: 'systems/mbrain',
          page_id: 42,
          chunk_index: 7,
          chunk_source: 'compiled_truth',
          chunk_text: longChunk,
          score: 0.01,
        }),
      ],
    } as Pick<BrainEngine, 'searchKeyword' | 'searchVector'> as BrainEngine;

    const results = await hybridSearch(engine, 'semantic audit', { limit: 5 });

    expect(results.map((entry) => entry.slug)[0]).toBe('systems/mbrain');
    expect(results.filter((entry) => entry.page_id === 42 && entry.chunk_index === 7)).toHaveLength(1);
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

  test('flags vector_skipped when the embedding provider is unavailable', async () => {
    setEmbeddingProviderForTests(disabledProvider as any);

    const { results, vector_failed, vector_skipped } = await hybridSearchWithMeta(keywordOnlyEngine(), 'context', {});

    expect(results.length).toBeGreaterThan(0);
    expect(vector_failed).toBe(false);
    expect(vector_skipped).toBe(true);
  });

  test('flags vector_failed when embedding fails after provider resolution', async () => {
    setEmbeddingProviderForTests({
      capability: {
        available: true,
        mode: 'local',
        implementation: 'test-local',
        model: 'test-local-v1',
        dimensions: 3,
      },
      embedBatch: async () => {
        throw new Error('embedding service unavailable');
      },
    });

    const { results, vector_failed, vector_skipped } = await hybridSearchWithMeta(keywordOnlyEngine(), 'context', {});

    expect(results.length).toBeGreaterThan(0);
    expect(vector_failed).toBe(true);
    expect(vector_skipped).toBe(false);
  });

  test('surfaces embedding coverage warnings when semantic search has missing chunks', async () => {
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
      searchKeyword: async () => [makeResult()],
      searchVector: async () => [],
      getHealth: async () => ({
        page_count: 1,
        embed_coverage: 0.5,
        stale_pages: 0,
        orphan_pages: 0,
        dead_links: 0,
        missing_embeddings: 2,
      }),
    } as Pick<BrainEngine, 'searchKeyword' | 'searchVector' | 'getHealth'> as BrainEngine;

    const { embedding_coverage_warning } = await hybridSearchWithMeta(engine, 'context', {});

    expect(embedding_coverage_warning).toContain('2 chunks are missing embeddings');
  });
});
