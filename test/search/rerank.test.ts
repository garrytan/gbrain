/**
 * v0.35.0.0+ applyReranker tests.
 *
 * Pins:
 *  - reorder by reranker score (the happy path)
 *  - preserve un-reranked tail order (recall protection)
 *  - fail-open on every RerankError reason (audit-logged, results pass through)
 *  - topNOut=null preserves full length (CDX2-F16 — semantic distinction
 *    between null and undefined)
 *  - empty input passes through
 *  - rerankerFn test seam used over gateway.rerank
 */

import { describe, test, expect, beforeAll } from 'bun:test';
import { applyReranker, type RerankerOpts } from '../../src/core/search/rerank.ts';
import { RerankError, type RerankResult } from '../../src/core/ai/gateway.ts';
import type { SearchResult } from '../../src/core/types.ts';

function makeResult(slug: string, score: number, chunk: string): SearchResult {
  return {
    slug,
    page_id: 0,
    title: slug,
    type: 'note',
    chunk_text: chunk,
    chunk_source: 'compiled_truth',
    chunk_id: 0,
    chunk_index: 0,
    score,
    stale: false,
  };
}

// Setup: gateway must be configured so the rerank-audit logger doesn't
// trip on missing env. We can call configureGateway with a minimal stub.
beforeAll(async () => {
  const { configureGateway } = await import('../../src/core/ai/gateway.ts');
  configureGateway({
    env: { ZEROENTROPY_API_KEY: 'test-key' },
  });
});

describe('applyReranker — happy path', () => {
  test('reorders top-N by reranker relevance score', async () => {
    const results = [
      makeResult('a', 1.0, 'doc a'),
      makeResult('b', 0.9, 'doc b'),
      makeResult('c', 0.8, 'doc c'),
    ];
    const opts: RerankerOpts = {
      enabled: true,
      topNIn: 3,
      topNOut: null,
      rerankerFn: async () => [
        { index: 2, relevanceScore: 0.99 }, // c wins
        { index: 0, relevanceScore: 0.5 },  // a second
        { index: 1, relevanceScore: 0.1 },  // b last
      ],
    };
    const out = await applyReranker('q', results, opts);
    expect(out.map(r => r.slug)).toEqual(['c', 'a', 'b']);
  });

  test('un-reranked tail preserves original RRF order', async () => {
    const results = [
      makeResult('head1', 1.0, 'h1'),
      makeResult('head2', 0.9, 'h2'),
      makeResult('tail1', 0.5, 't1'),
      makeResult('tail2', 0.4, 't2'),
    ];
    const opts: RerankerOpts = {
      enabled: true,
      topNIn: 2,
      topNOut: null,
      rerankerFn: async () => [
        { index: 1, relevanceScore: 0.99 },
        { index: 0, relevanceScore: 0.5 },
      ],
    };
    const out = await applyReranker('q', results, opts);
    // Head reordered: head2 first, head1 second. Tail unchanged: tail1, tail2.
    expect(out.map(r => r.slug)).toEqual(['head2', 'head1', 'tail1', 'tail2']);
  });

  test('stamps rerank_score onto reordered items', async () => {
    const results = [makeResult('a', 1.0, 'a')];
    const opts: RerankerOpts = {
      enabled: true,
      topNIn: 1,
      topNOut: null,
      rerankerFn: async () => [{ index: 0, relevanceScore: 0.42 }],
    };
    const out = await applyReranker('q', results, opts);
    expect((out[0] as any).rerank_score).toBe(0.42);
  });
});

describe('applyReranker — CDX2-F16 null vs undefined semantics', () => {
  test('topNOut=null preserves full reordered list', async () => {
    const results = Array.from({ length: 50 }, (_, i) => makeResult(`p${i}`, 1 - i * 0.01, `c${i}`));
    const opts: RerankerOpts = {
      enabled: true,
      topNIn: 30,
      topNOut: null,
      rerankerFn: async (input) => input.documents.map((_, i) => ({ index: i, relevanceScore: 1 - i * 0.01 })),
    };
    const out = await applyReranker('q', results, opts);
    // tokenmax mode has searchLimit=50 — null must preserve all 50.
    expect(out.length).toBe(50);
  });

  test('topNOut=10 truncates to 10', async () => {
    const results = Array.from({ length: 30 }, (_, i) => makeResult(`p${i}`, 1 - i * 0.01, `c${i}`));
    const opts: RerankerOpts = {
      enabled: true,
      topNIn: 30,
      topNOut: 10,
      rerankerFn: async (input) => input.documents.map((_, i) => ({ index: i, relevanceScore: 1 - i * 0.01 })),
    };
    const out = await applyReranker('q', results, opts);
    expect(out.length).toBe(10);
  });
});

describe('applyReranker — fail-open on every RerankError reason', () => {
  test.each([
    'auth' as const,
    'rate_limit' as const,
    'network' as const,
    'timeout' as const,
    'payload_too_large' as const,
    'unknown' as const,
  ])('fail-open on RerankError reason=%s', async (reason) => {
    const results = [
      makeResult('a', 1.0, 'a'),
      makeResult('b', 0.5, 'b'),
    ];
    const opts: RerankerOpts = {
      enabled: true,
      topNIn: 2,
      topNOut: null,
      rerankerFn: async () => {
        throw new RerankError('forced', reason);
      },
    };
    // Must not throw; must return input unchanged.
    const out = await applyReranker('q', results, opts);
    expect(out).toEqual(results);
  });

  test('fail-open on non-RerankError throw too', async () => {
    const results = [makeResult('a', 1.0, 'a')];
    const opts: RerankerOpts = {
      enabled: true,
      topNIn: 1,
      topNOut: null,
      rerankerFn: async () => {
        throw new Error('arbitrary');
      },
    };
    const out = await applyReranker('q', results, opts);
    expect(out).toEqual(results);
  });

  test('fail-open on malformed reranker response (empty results array)', async () => {
    const results = [makeResult('a', 1.0, 'a')];
    const opts: RerankerOpts = {
      enabled: true,
      topNIn: 1,
      topNOut: null,
      rerankerFn: async () => [],
    };
    const out = await applyReranker('q', results, opts);
    expect(out).toEqual(results);
  });
});

describe('applyReranker — pass-through cases', () => {
  test('enabled=false passes through unchanged (no rerankerFn call)', async () => {
    const results = [makeResult('a', 1.0, 'a'), makeResult('b', 0.5, 'b')];
    let called = false;
    const opts: RerankerOpts = {
      enabled: false,
      topNIn: 30,
      topNOut: null,
      rerankerFn: async () => { called = true; return []; },
    };
    const out = await applyReranker('q', results, opts);
    expect(out).toEqual(results);
    expect(called).toBe(false);
  });

  test('empty results passes through immediately', async () => {
    let called = false;
    const opts: RerankerOpts = {
      enabled: true,
      topNIn: 30,
      topNOut: null,
      rerankerFn: async () => { called = true; return []; },
    };
    const out = await applyReranker('q', [], opts);
    expect(out).toEqual([]);
    expect(called).toBe(false);
  });
});
