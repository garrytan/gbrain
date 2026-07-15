/**
 * v0.36.0.0 (D6 + C2) — balanced mode bundle now defaults reranker_enabled=true.
 *
 * Pins:
 *  - MODE_BUNDLES.balanced.reranker_enabled === true (the flip)
 *  - applyReranker honors the flag (calls injected rerankerFn)
 *  - Fail-open contract: missing key / network error returns input unchanged
 *  - rerankerFn is called with input_type-equivalent shape for the query path
 */

import { describe, test, expect } from 'bun:test';
import { MODE_BUNDLES } from '../src/core/search/mode.ts';
import { applyReranker, type RerankerOpts } from '../src/core/search/rerank.ts';
import type { SearchResult } from '../src/core/types.ts';
import { RerankError } from '../src/core/ai/gateway.ts';

describe('Mode bundle defaults (D6)', () => {
  test('balanced.reranker_enabled is true (the v0.36.0.0 flip)', () => {
    expect(MODE_BUNDLES.balanced.reranker_enabled).toBe(true);
  });

  test('balanced reranker model is zeroentropyai:zerank-2', () => {
    expect(MODE_BUNDLES.balanced.reranker_model).toBe('zeroentropyai:zerank-2');
  });

  test('conservative reranker stays off (cheap tier)', () => {
    expect(MODE_BUNDLES.conservative.reranker_enabled).toBe(false);
  });

  test('tokenmax reranker still on', () => {
    expect(MODE_BUNDLES.tokenmax.reranker_enabled).toBe(true);
  });
});

function makeResults(n: number): SearchResult[] {
  const out: SearchResult[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      slug: `doc/${i}`,
      page_id: i + 1,
      title: `Doc ${i}`,
      type: 'note',
      chunk_text: `This is doc ${i}, an example chunk text for rerank testing.`,
      chunk_source: 'compiled_truth',
      chunk_id: i + 100,
      chunk_index: 0,
      score: 1 / (i + 1),
      stale: false,
    });
  }
  return out;
}

describe('applyReranker — fail-open contract (D6 + R8)', () => {
  test('reranker disabled: passthrough', async () => {
    const results = makeResults(5);
    const opts: RerankerOpts = {
      enabled: false,
      topNIn: 30,
      topNOut: null,
      rerankerFn: async () => { throw new Error('should not be called'); },
    };
    const out = await applyReranker('test query', results, opts);
    expect(out).toEqual(results);
  });

  test('reranker enabled + thrown error: returns input order unchanged', async () => {
    const results = makeResults(5);
    const opts: RerankerOpts = {
      enabled: true,
      topNIn: 30,
      topNOut: null,
      rerankerFn: async () => {
        throw new RerankError('missing ZEROENTROPY_API_KEY', 'auth');
      },
    };
    const out = await applyReranker('test query', results, opts);
    // Fail-open: original order preserved.
    expect(out.map(r => r.slug)).toEqual(results.map(r => r.slug));
  });

  test('reranker enabled + happy path: reorders by relevance_score', async () => {
    const results = makeResults(3);
    const opts: RerankerOpts = {
      enabled: true,
      topNIn: 30,
      topNOut: null,
      rerankerFn: async () => {
        // Reverse the order: doc/2 first, doc/0 last.
        return [
          { index: 2, relevanceScore: 0.95 },
          { index: 1, relevanceScore: 0.50 },
          { index: 0, relevanceScore: 0.10 },
        ];
      },
    };
    const out = await applyReranker('test query', results, opts);
    expect(out.map(r => r.slug)).toEqual(['doc/2', 'doc/1', 'doc/0']);
  });

  test('empty results: passthrough (no upstream call)', async () => {
    let called = false;
    const opts: RerankerOpts = {
      enabled: true,
      topNIn: 30,
      topNOut: null,
      rerankerFn: async () => { called = true; return []; },
    };
    const out = await applyReranker('test query', [], opts);
    expect(out).toEqual([]);
    expect(called).toBe(false);
  });

  test('preserves un-reranked tail past topNIn (recall protection)', async () => {
    const results = makeResults(10);
    const opts: RerankerOpts = {
      enabled: true,
      topNIn: 3, // only rerank top 3
      topNOut: null,
      rerankerFn: async () => [
        { index: 2, relevanceScore: 0.99 },
        { index: 0, relevanceScore: 0.50 },
        { index: 1, relevanceScore: 0.10 },
      ],
    };
    const out = await applyReranker('test query', results, opts);
    // Head: reranked. Tail: original positions 3-9 in order.
    expect(out.slice(0, 3).map(r => r.slug)).toEqual(['doc/2', 'doc/0', 'doc/1']);
    expect(out.slice(3).map(r => r.slug)).toEqual([
      'doc/3', 'doc/4', 'doc/5', 'doc/6', 'doc/7', 'doc/8', 'doc/9',
    ]);
  });
});

describe('Reranker invocation receives query + documents', () => {
  test('rerankerFn called with query + document texts from top N', async () => {
    const results = makeResults(5);
    let received: { query: string; documents: string[] } | null = null;
    const opts: RerankerOpts = {
      enabled: true,
      topNIn: 3,
      topNOut: null,
      rerankerFn: async (input) => {
        received = { query: input.query, documents: input.documents };
        return [
          { index: 0, relevanceScore: 0.9 },
          { index: 1, relevanceScore: 0.5 },
          { index: 2, relevanceScore: 0.1 },
        ];
      },
    };
    await applyReranker('what is foo?', results, opts);
    expect(received).not.toBeNull();
    expect(received!.query).toBe('what is foo?');
    expect(received!.documents.length).toBe(3);
    expect(received!.documents[0]).toContain('doc 0');
  });
});
