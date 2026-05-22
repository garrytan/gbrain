/**
 * v0.35.0.0 — hybridSearch ↔ applyReranker integration tests.
 *
 * Drives bare hybridSearch (NOT the cached wrapper — that adds an embed
 * call we don't want here) against PGLite with a stubbed rerankerFn so
 * we can pin:
 *
 *  - Reranker fires when opts.reranker.enabled=true and reorders the
 *    candidate pool.
 *  - Reranker does NOT fire when opts.reranker.enabled=false.
 *  - Tail beyond topNIn is preserved in its original RRF order.
 *  - Cache hit path stores the reranked order (CDX2-F15 — cached rows
 *    are final reranked results, not pre-rerank candidates).
 *
 * No API keys needed; embedding is stubbed via __setEmbedTransportForTests.
 * The reranker is stubbed via opts.reranker.rerankerFn so we never call
 * gateway.rerank.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { hybridSearch } from '../../src/core/search/hybrid.ts';
import {
  configureGateway,
  resetGateway,
  __setEmbedTransportForTests,
} from '../../src/core/ai/gateway.ts';
import type { PageInput, SearchOpts } from '../../src/core/types.ts';
import type { RerankInput, RerankResult } from '../../src/core/ai/gateway.ts';

let engine: PGLiteEngine;

const DIMS = 1536; // gateway default embedding dim
const FAKE_EMB = Array.from({ length: DIMS }, (_, j) => (j === 0 ? 1 : 0.01));

function stubEmbeddings(): void {
  __setEmbedTransportForTests(async (args: any) => ({
    embeddings: args.values.map(() => FAKE_EMB),
  }) as any);
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  // Seed pages whose content includes a shared keyword so the keyword
  // path will match and produce a candidate pool of 4+ items. putPage
  // alone doesn't populate content_chunks (the table searchKeyword
  // queries) — upsertChunks does that, and we manually seed it here
  // so keyword search has rows to find without needing the full
  // chunker + embed pipeline.
  const pages: Array<[string, PageInput, string]> = [
    ['notes/alpha', { type: 'note', title: 'Alpha Note', compiled_truth: 'alpha keyword content one' }, 'alpha keyword content one chunk'],
    ['notes/beta',  { type: 'note', title: 'Beta Note',  compiled_truth: 'alpha keyword content two' }, 'alpha keyword content two chunk'],
    ['notes/gamma', { type: 'note', title: 'Gamma Note', compiled_truth: 'alpha keyword content three' }, 'alpha keyword content three chunk'],
    ['notes/delta', { type: 'note', title: 'Delta Note', compiled_truth: 'alpha keyword content four' }, 'alpha keyword content four chunk'],
  ];
  for (const [slug, page, chunkText] of pages) {
    await engine.putPage(slug, page);
    await engine.upsertChunks(slug, [
      { chunk_index: 0, chunk_text: chunkText, chunk_source: 'compiled_truth' },
    ]);
  }

  // Configure with sk-test + stubbed embed transport. We DO need the
  // gateway available (env set + transport stubbed) so hybridSearch
  // takes the main RRF path — the keyword-only fallback at ~hybrid.ts:409
  // early-returns BEFORE applyReranker, so a setup that lacks embedding
  // would never exercise the reranker integration.
  //
  // searchVector returns empty lists because chunks have NULL embeddings;
  // that's fine — vectorLists is `[[]]` (length 1, not 0), so the
  // keyword-only branch is skipped and the main path runs RRF + dedup +
  // reranker + budget.
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: DIMS,
    env: { OPENAI_API_KEY: 'sk-test' },
  });
  stubEmbeddings();
});

afterAll(async () => {
  __setEmbedTransportForTests(null);
  resetGateway();
  await engine.disconnect();
});

describe('hybridSearch — reranker disabled (pass-through)', () => {
  test('opts.reranker undefined: reranker does NOT fire', async () => {
    let called = 0;
    const opts: SearchOpts = {
      limit: 10,
      reranker: {
        enabled: false,
        topNIn: 30,
        topNOut: null,
        rerankerFn: async () => { called++; return []; },
      },
    };
    const out = await hybridSearch(engine, 'alpha', opts);
    expect(out.length).toBeGreaterThan(0);
    expect(called).toBe(0);
  });
});

describe('hybridSearch — reranker enabled (reorder)', () => {
  test('rerankerFn receives a non-empty document list', async () => {
    let receivedDocs: string[] = [];
    const opts: SearchOpts = {
      limit: 10,
      reranker: {
        enabled: true,
        topNIn: 30,
        topNOut: null,
        rerankerFn: async (input: RerankInput): Promise<RerankResult[]> => {
          receivedDocs = input.documents;
          return input.documents.map((_, i) => ({ index: i, relevanceScore: 1 - i * 0.1 }));
        },
      },
    };
    const out = await hybridSearch(engine, 'alpha keyword', opts);
    expect(out.length).toBeGreaterThan(0);
    expect(receivedDocs.length).toBeGreaterThan(0);
    expect(receivedDocs.length).toBe(out.length); // when topNIn >= pool, all sent
  });

  test('rerankerFn output controls final order (reverse the RRF order)', async () => {
    let originalOrder: string[] = [];
    const opts: SearchOpts = {
      limit: 10,
      reranker: {
        enabled: true,
        topNIn: 30,
        topNOut: null,
        // Reverse the order: last-in becomes first-out.
        rerankerFn: async (input: RerankInput): Promise<RerankResult[]> => {
          return input.documents.map((_, i) => ({
            index: input.documents.length - 1 - i,
            relevanceScore: 1 - i * 0.1,
          }));
        },
      },
    };
    // First run: collect the original RRF order (rerankerFn off).
    const baseline = await hybridSearch(engine, 'alpha keyword', {
      ...opts,
      reranker: { ...opts.reranker!, enabled: false },
    });
    originalOrder = baseline.map(r => r.slug);

    // Second run: reranker reverses.
    const reranked = await hybridSearch(engine, 'alpha keyword', opts);
    const rerankedOrder = reranked.map(r => r.slug);

    expect(rerankedOrder).toEqual([...originalOrder].reverse());
  });

  test('un-reranked tail preserves RRF order (topNIn=2 with N candidates)', async () => {
    // First baseline. PGLite's hybrid path + dedup may collapse some
    // chunks; we need at least 3 candidates (2 reranked head + 1
    // preserved tail) for this assertion to be meaningful.
    const baseline = await hybridSearch(engine, 'alpha keyword', { limit: 10 });
    const baselineOrder = baseline.map(r => r.slug);
    expect(baselineOrder.length).toBeGreaterThanOrEqual(3);

    // Now rerank only the top 2 (swap them); the tail (indices 2..N-1)
    // must keep its baseline order.
    const reranked = await hybridSearch(engine, 'alpha keyword', {
      limit: 10,
      reranker: {
        enabled: true,
        topNIn: 2,
        topNOut: null,
        rerankerFn: async (input: RerankInput): Promise<RerankResult[]> => [
          { index: 1, relevanceScore: 0.99 },
          { index: 0, relevanceScore: 0.5 },
        ],
      },
    });
    const rerankedOrder = reranked.map(r => r.slug);

    // Head reordered: positions 0 and 1 swapped.
    expect(rerankedOrder[0]).toBe(baselineOrder[1]);
    expect(rerankedOrder[1]).toBe(baselineOrder[0]);
    // Tail unchanged.
    expect(rerankedOrder.slice(2)).toEqual(baselineOrder.slice(2));
  });

  test('rerank score stamps onto results', async () => {
    const opts: SearchOpts = {
      limit: 10,
      reranker: {
        enabled: true,
        topNIn: 30,
        topNOut: null,
        rerankerFn: async (input: RerankInput): Promise<RerankResult[]> =>
          input.documents.map((_, i) => ({ index: i, relevanceScore: 0.5 - i * 0.05 })),
      },
    };
    const out = await hybridSearch(engine, 'alpha keyword', opts);
    expect(out.length).toBeGreaterThan(0);
    // First result has the highest reranker score (0.5).
    expect((out[0] as any).rerank_score).toBe(0.5);
  });
});

describe('hybridSearch — fail-open contract end-to-end', () => {
  test('rerankerFn throws → results still come back (RRF order preserved)', async () => {
    const baseline = await hybridSearch(engine, 'alpha keyword', { limit: 10 });
    const reranked = await hybridSearch(engine, 'alpha keyword', {
      limit: 10,
      reranker: {
        enabled: true,
        topNIn: 30,
        topNOut: null,
        rerankerFn: async () => { throw new Error('upstream down'); },
      },
    });
    // Same items, same order — applyReranker fail-open.
    expect(reranked.map(r => r.slug)).toEqual(baseline.map(r => r.slug));
  });
});
