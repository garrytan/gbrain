/**
 * LIVE e2e — Voyage rerank + embed wire confirmation (v0.46.3).
 *
 * Skip-gated on VOYAGE_API_KEY. This is the REQUIRED pre-ship confirmation of
 * the rerank wire contract the unit tests pin with stubs: POST
 * https://api.voyageai.com/v1/rerank with `top_k`, response
 * `{object: "list", data: [{index, relevance_score}]}` (the gateway parser
 * accepts both data[] and the legacy results[] dialect). Also round-trips one
 * voyage-4 embed at the new-install width (1024).
 *
 * Run: VOYAGE_API_KEY=... bun test test/e2e/voyage-rerank-live.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import {
  configureGateway,
  resetGateway,
  embedQuery,
  rerank,
} from '../../src/core/ai/gateway.ts';

const API_KEY = process.env.VOYAGE_API_KEY;
const skipAll = !API_KEY;

beforeAll(() => {
  if (skipAll) return;
  configureGateway({
    embedding_model: 'voyage:voyage-4',
    embedding_dimensions: 1024,
    reranker_model: 'voyage:rerank-2.5',
    env: { VOYAGE_API_KEY: API_KEY! },
  });
});

afterAll(() => {
  if (!skipAll) resetGateway();
});

describe('Voyage live — rerank wire contract', () => {
  test('rerank-2.5 returns relevance-ordered data[] and honors top_k', async () => {
    if (skipAll) {
      console.warn('[skip] VOYAGE_API_KEY not set');
      return;
    }
    const out = await rerank({
      query: 'What is the capital of France?',
      documents: [
        'The Eiffel Tower is in Paris, the capital of France.',
        'Bananas are a good source of potassium.',
        'Paris is the capital and largest city of France.',
      ],
      topN: 2,
    });
    // top_k honored on the wire: exactly 2 results back.
    expect(out.length).toBe(2);
    for (const r of out) {
      expect(typeof r.index).toBe('number');
      expect(typeof r.relevanceScore).toBe('number');
    }
    // Both returned docs must be the France-relevant ones (index 0 and 2) —
    // the potassium doc (index 1) is the one top_k=2 drops.
    const indices = out.map((r) => r.index).sort();
    expect(indices).toEqual([0, 2]);
    // Ordered by descending relevance.
    expect(out[0].relevanceScore).toBeGreaterThanOrEqual(out[1].relevanceScore);
  }, 30_000);

  test('rerank-2.5-lite also passes the wire', async () => {
    if (skipAll) {
      console.warn('[skip] VOYAGE_API_KEY not set');
      return;
    }
    resetGateway();
    configureGateway({
      reranker_model: 'voyage:rerank-2.5-lite',
      env: { VOYAGE_API_KEY: API_KEY! },
    });
    const out = await rerank({ query: 'hello', documents: ['hello world', 'goodbye'] });
    expect(out.length).toBe(2);
  }, 30_000);
});

describe('Voyage live — voyage-4 embed at the new-install width', () => {
  test('embedQuery returns a 1024-dim vector', async () => {
    if (skipAll) {
      console.warn('[skip] VOYAGE_API_KEY not set');
      return;
    }
    resetGateway();
    configureGateway({
      embedding_model: 'voyage:voyage-4',
      embedding_dimensions: 1024,
      env: { VOYAGE_API_KEY: API_KEY! },
    });
    const vec = await embedQuery('fresh install smoke');
    expect(vec.length).toBe(1024);
  }, 30_000);
});
