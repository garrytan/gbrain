/**
 * cosineReScore must not give a chunkless row (the synthetic
 * chunk_id=0/COALESCE row for a chunkless page, e.g. an embed_skip'd
 * oversized page — or any chunk_id whose embedding failed to hydrate) a
 * raw-scale head start over rows that got compressed onto the [0, 1.0]
 * blended scale.
 *
 * Pre-fix: `if (!chunkEmb) return r;` returned the row completely
 * untouched, so its RAW post-RRF score (on whatever scale upstream fusion
 * produced, up to ~2.0 with the compiled_truth boost) survived alongside
 * every other row's [0, 1.0]-scale blended score — a structural 2x head
 * start. Reported on #3695: a 602KB embed_skip page with an empty snippet
 * became the #1 result for 15/25 queries in a regression set, displacing
 * on-point pages, purely from this scale mismatch (not from actual
 * relevance).
 *
 * Fix: route the chunkless row through the identical blend formula with
 * cosine=0, so it's compressed onto the same scale as every other row —
 * without excluding it (which would make embed_skip pages unsearchable, a
 * different behavior change).
 */

import { describe, expect, test } from 'bun:test';
import { cosineReScore } from '../src/core/search/hybrid.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { SearchResult } from '../src/core/types.ts';

function fakeEngine(embeddings: Map<number, Float32Array>): BrainEngine {
  return {
    getEmbeddingsByChunkIds: async (chunkIds: number[]) => {
      const map = new Map<number, Float32Array>();
      for (const id of chunkIds) {
        const v = embeddings.get(id);
        if (v) map.set(id, v);
      }
      return map;
    },
  } as unknown as BrainEngine;
}

function result(overrides: Partial<SearchResult> & { chunk_id: number; score: number }): SearchResult {
  return {
    slug: 'test/page',
    page_id: 1,
    title: 'Test',
    type: 'note',
    chunk_text: 'text',
    chunk_source: 'compiled_truth',
    chunk_index: 0,
    stale: false,
    ...overrides,
  } as SearchResult;
}

describe('cosineReScore — chunkless-row head start (#3695)', () => {
  test('a chunkless row (chunk_id=0, no hydratable embedding) is compressed onto the same [0,1.0] scale, not left on its raw score', async () => {
    const queryEmbedding = new Float32Array([1, 0, 0]);
    // Chunked row's embedding is orthogonal to the query — cosine=0, so its
    // blend is entirely lexical: 0.7 * normRrf.
    const chunkedEmbedding = new Float32Array([0, 1, 0]);
    const engine = fakeEngine(new Map([[42, chunkedEmbedding]]));

    // Same base (post-fusion, pre-boost) RRF score for both rows — an
    // apples-to-apples comparison of what the rescore step alone does.
    const chunklessRaw = 1.8650; // reproduces the exact #3695 reported score
    const chunkedRaw = 1.8650;

    const results: SearchResult[] = [
      result({ slug: 'chunkless/embed-skip-page', chunk_id: 0, chunk_text: '', score: chunklessRaw }),
      result({ slug: 'chunked/on-point-page', chunk_id: 42, score: chunkedRaw }),
    ];

    const rescored = await cosineReScore(engine, results, queryEmbedding, 'embedding');
    const chunkless = rescored.find(r => r.slug === 'chunkless/embed-skip-page')!;
    const chunked = rescored.find(r => r.slug === 'chunked/on-point-page')!;

    // The chunkless row must NOT retain its raw ~1.86 score — it must be
    // compressed to the blended scale, same as the chunked row.
    expect(chunkless.score).not.toBeCloseTo(chunklessRaw, 2);
    expect(chunkless.score).toBeLessThanOrEqual(1.0);
    expect(chunked.score).toBeLessThanOrEqual(1.0);

    // Both rows had identical base scores and cosine=0 (chunkless has no
    // embedding; the chunked row's embedding is orthogonal to the query) —
    // so both should land on the exact same blended score. Neither
    // structurally outranks the other from the rescore step alone.
    expect(chunkless.score).toBeCloseTo(chunked.score, 6);
    expect(chunkless.cosine).toBe(0);
  });

  test('a chunkless page with genuine lexical relevance still surfaces (not excluded)', async () => {
    const queryEmbedding = new Float32Array([1, 0, 0]);
    const engine = fakeEngine(new Map());

    const results: SearchResult[] = [
      result({ slug: 'chunkless/lexical-hit', chunk_id: 0, chunk_text: '', score: 0.9 }),
    ];

    const rescored = await cosineReScore(engine, results, queryEmbedding, 'embedding');
    expect(rescored).toHaveLength(1);
    expect(rescored[0].slug).toBe('chunkless/lexical-hit');
    expect(Number.isFinite(rescored[0].score)).toBe(true);
  });

  test('an embedded row with a genuinely relevant embedding still outranks an unrelated chunkless row', async () => {
    const queryEmbedding = new Float32Array([1, 0, 0]);
    // Perfectly aligned with the query — cosine=1.
    const relevantEmbedding = new Float32Array([1, 0, 0]);
    const engine = fakeEngine(new Map([[7, relevantEmbedding]]));

    const results: SearchResult[] = [
      result({ slug: 'chunkless/unrelated', chunk_id: 0, chunk_text: '', score: 1.8 }),
      result({ slug: 'chunked/relevant', chunk_id: 7, score: 1.8 }),
    ];

    const rescored = await cosineReScore(engine, results, queryEmbedding, 'embedding');
    expect(rescored[0].slug).toBe('chunked/relevant');
  });
});
