/**
 * v0.35.0.0 — ZeroEntropy live E2E tests.
 *
 * Real HTTP round-trip against `api.zeroentropy.dev`. Gated on
 * `ZEROENTROPY_API_KEY` — when absent, every test skips gracefully so
 * `bun run test:e2e` stays green on contributor machines that don't have
 * a ZE account.
 *
 * Pins (only meaningful when the env var is set):
 *  - POST /v1/models/embed returns float embeddings that round-trip
 *    through the AI-SDK adapter (after zeroEntropyCompatFetch's response
 *    rewrite).
 *  - dimensions parameter is honored: 2560 default → vector of length
 *    2560; 1280 → 1280; etc.
 *  - asymmetric input_type plumbing reaches ZE: embedQuery() and embed()
 *    both succeed and return same-shape vectors (we can't easily inspect
 *    whether ZE actually produced asymmetric vectors without a reference
 *    corpus, but the request must succeed without HTTP 400).
 *  - POST /v1/models/rerank returns indices + relevance_scores that
 *    round-trip through gateway.rerank() into RerankResult[].
 *
 * Cost note: each test fires 1-2 HTTP requests. At $0.025/1M tokens and
 * ~100 tokens per test, the full file costs well under a cent. Still
 * gated by env so contributor PR CI doesn't spend.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import {
  configureGateway,
  resetGateway,
  embed,
  embedQuery,
  rerank,
} from '../../src/core/ai/gateway.ts';

const API_KEY = process.env.ZEROENTROPY_API_KEY;

// Skip the entire file when env is absent. `describe.skipIf` exists in
// modern bun:test; fall back to in-test guards for older runners.
const skipAll = !API_KEY;

beforeAll(() => {
  if (skipAll) return;
  configureGateway({
    embedding_model: 'zeroentropyai:zembed-1',
    embedding_dimensions: 2560,
    reranker_model: 'zeroentropyai:zerank-2',
    env: { ZEROENTROPY_API_KEY: API_KEY! },
  });
});

afterAll(() => {
  if (!skipAll) resetGateway();
});

describe('ZE live — embed round-trip', () => {
  test('embed(["text"]) returns Float32Array[2560]', async () => {
    if (skipAll) {
      console.warn('[skip] ZEROENTROPY_API_KEY not set');
      return;
    }
    const [v] = await embed(['hello world']);
    expect(v).toBeInstanceOf(Float32Array);
    expect(v.length).toBe(2560);
    // Sanity: at least one non-zero element (otherwise the response
    // rewrite probably dropped the payload).
    const anyNonZero = Array.from(v).some(x => x !== 0);
    expect(anyNonZero).toBe(true);
  });

  test('embedQuery("text") returns Float32Array[2560] (query side)', async () => {
    if (skipAll) {
      console.warn('[skip] ZEROENTROPY_API_KEY not set');
      return;
    }
    const v = await embedQuery('what is foo');
    expect(v).toBeInstanceOf(Float32Array);
    expect(v.length).toBe(2560);
    const anyNonZero = Array.from(v).some(x => x !== 0);
    expect(anyNonZero).toBe(true);
  });

  test('embed batch of 3 returns 3 vectors in order', async () => {
    if (skipAll) {
      console.warn('[skip] ZEROENTROPY_API_KEY not set');
      return;
    }
    const out = await embed(['one', 'two', 'three']);
    expect(out.length).toBe(3);
    for (const v of out) {
      expect(v).toBeInstanceOf(Float32Array);
      expect(v.length).toBe(2560);
    }
    // Different inputs → different vectors (sanity check; would fail
    // hard if the response-rewriter accidentally returned the same
    // vector for every input).
    expect(out[0]).not.toEqual(out[1]);
    expect(out[1]).not.toEqual(out[2]);
  });
});

// ZE rerank API has multi-second cold-start latency on the first request
// of a CI run (observed ~5-6s on Tier 2 runners; subsequent calls < 500ms).
// The production DEFAULT_RERANK_TIMEOUT_MS in gateway.ts stays at 5s for the
// search hot path; these E2E tests pass an explicit input.timeoutMs and a
// longer bun:test per-test timeout so cold-start doesn't flake CI.
const ZE_RERANK_TIMEOUT_MS = 25_000;
const ZE_TEST_TIMEOUT_MS = 30_000;

describe('ZE live — rerank round-trip', () => {
  test('rerank({query, documents}) returns sorted RerankResult[]', async () => {
    if (skipAll) {
      console.warn('[skip] ZEROENTROPY_API_KEY not set');
      return;
    }
    const out = await rerank({
      query: 'how does photosynthesis work',
      documents: [
        'Photosynthesis is the process by which plants convert sunlight to energy.',
        'My cat likes to eat tuna fish.',
        'Chlorophyll absorbs red and blue light during photosynthesis.',
      ],
      timeoutMs: ZE_RERANK_TIMEOUT_MS,
    });
    expect(out.length).toBe(3);
    for (const r of out) {
      expect(typeof r.index).toBe('number');
      expect(typeof r.relevanceScore).toBe('number');
      // ZE relevance scores are in [0, 1]. Pin the range so a future
      // contract change is loud.
      expect(r.relevanceScore).toBeGreaterThanOrEqual(0);
      expect(r.relevanceScore).toBeLessThanOrEqual(1);
    }
    // Photosynthesis-relevant docs should score higher than the cat doc.
    // We don't pin a specific order (zerank-2 may re-rank the two
    // photosynthesis docs in either order depending on phrasing), but
    // the cat doc must NOT be at the top.
    const topIndex = out[0]!.index;
    expect(topIndex).not.toBe(1); // index 1 is the cat doc
  }, ZE_TEST_TIMEOUT_MS);

  test('rerank with top_n=2 returns at most 2 results', async () => {
    if (skipAll) {
      console.warn('[skip] ZEROENTROPY_API_KEY not set');
      return;
    }
    const out = await rerank({
      query: 'photosynthesis',
      documents: ['photosynthesis a', 'cats b', 'photosynthesis c'],
      topN: 2,
      timeoutMs: ZE_RERANK_TIMEOUT_MS,
    });
    expect(out.length).toBeLessThanOrEqual(2);
  }, ZE_TEST_TIMEOUT_MS);
});

describe('ZE live — flexible dims', () => {
  test('1280-dim embedding returns Float32Array[1280]', async () => {
    if (skipAll) {
      console.warn('[skip] ZEROENTROPY_API_KEY not set');
      return;
    }
    resetGateway();
    configureGateway({
      embedding_model: 'zeroentropyai:zembed-1',
      embedding_dimensions: 1280,
      env: { ZEROENTROPY_API_KEY: API_KEY! },
    });
    const [v] = await embed(['1280 dim test']);
    expect(v.length).toBe(1280);
    // Restore 2560 for subsequent tests.
    resetGateway();
    configureGateway({
      embedding_model: 'zeroentropyai:zembed-1',
      embedding_dimensions: 2560,
      reranker_model: 'zeroentropyai:zerank-2',
      env: { ZEROENTROPY_API_KEY: API_KEY! },
    });
  });
});
