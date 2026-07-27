/**
 * v0.35.0.0 — gateway.rerank() HTTP path tests.
 *
 * Drives the public `rerank()` function with a stubbed `_rerankTransport`
 * (the canonical test seam — same pattern as `__setEmbedTransportForTests`).
 *
 * Pins:
 *  - Request URL is `${recipe.base_url_default}/models/rerank` — i.e.
 *    `https://api.zeroentropy.dev/v1/models/rerank`, NOT `/v1/v1/…`
 *    (CDX1-F2 regression).
 *  - Request body shape: `{model, query, documents, top_n?}`.
 *  - Bearer auth header from `applyResolveAuth` ↔ ZEROENTROPY_API_KEY.
 *  - Response parsing: `{results: [{index, relevance_score}]}` →
 *    `RerankResult[]` with `{index, relevanceScore}`.
 *  - Error classification: 401/403 → auth, 429 → rate_limit, 5xx → network,
 *    other 4xx → unknown; AbortError on timeout → timeout.
 *  - Pre-flight payload guard: body over `max_payload_bytes` throws
 *    payload_too_large BEFORE any HTTP call (no transport invocation).
 *  - Empty documents → empty result, no HTTP call.
 *  - Model allowlist enforcement (CDX2-F11): `assertTouchpoint` doesn't
 *    enforce allowlists for openai-compatible recipes; rerank() does the
 *    check directly.
 */

import { describe, test, expect, afterEach, beforeEach } from 'bun:test';
import {
  configureGateway,
  resetGateway,
  rerank,
  RerankError,
  __setRerankTransportForTests,
} from '../../src/core/ai/gateway.ts';

function configureZE(model: string = 'zeroentropyai:zerank-2'): void {
  configureGateway({
    reranker_model: model,
    env: { ZEROENTROPY_API_KEY: 'sk-test-zerokey' },
  });
}

function mockResp(json: unknown, status = 200): Response {
  return new Response(JSON.stringify(json), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  __setRerankTransportForTests(null);
  resetGateway();
});

describe('gateway.rerank() — happy path', () => {
  beforeEach(() => configureZE());

  test('sends the right URL (CDX1-F2 — no /v1/v1/ doubling)', async () => {
    let capturedUrl = '';
    __setRerankTransportForTests(async (url) => {
      capturedUrl = url;
      return mockResp({ results: [{ index: 0, relevance_score: 0.9 }] });
    });
    await rerank({ query: 'q', documents: ['d'] });
    expect(capturedUrl).toBe('https://api.zeroentropy.dev/v1/models/rerank');
    expect(capturedUrl).not.toContain('/v1/v1/');
  });

  test('sends the right body shape', async () => {
    let captured: any = null;
    __setRerankTransportForTests(async (_url, init) => {
      captured = JSON.parse(init.body as string);
      return mockResp({ results: [{ index: 0, relevance_score: 0.9 }] });
    });
    await rerank({ query: 'q', documents: ['d1', 'd2'], topN: 5 });
    expect(captured).toEqual({
      model: 'zerank-2',
      query: 'q',
      documents: ['d1', 'd2'],
      top_n: 5,
    });
  });

  test('omits top_n when not provided', async () => {
    let captured: any = null;
    __setRerankTransportForTests(async (_url, init) => {
      captured = JSON.parse(init.body as string);
      return mockResp({ results: [{ index: 0, relevance_score: 0.5 }] });
    });
    await rerank({ query: 'q', documents: ['d'] });
    expect('top_n' in captured).toBe(false);
  });

  test('uses Bearer auth from ZEROENTROPY_API_KEY', async () => {
    let authHeader = '';
    __setRerankTransportForTests(async (_url, init) => {
      const headers = new Headers(init.headers as HeadersInit);
      authHeader = headers.get('authorization') ?? '';
      return mockResp({ results: [{ index: 0, relevance_score: 1.0 }] });
    });
    await rerank({ query: 'q', documents: ['d'] });
    expect(authHeader).toBe('Bearer sk-test-zerokey');
  });

  test('Content-Type: application/json', async () => {
    let contentType = '';
    __setRerankTransportForTests(async (_url, init) => {
      const headers = new Headers(init.headers as HeadersInit);
      contentType = headers.get('content-type') ?? '';
      return mockResp({ results: [] });
    });
    await rerank({ query: 'q', documents: ['d'] });
    expect(contentType).toBe('application/json');
  });

  test('maps response.results[].relevance_score → relevanceScore', async () => {
    __setRerankTransportForTests(async () =>
      mockResp({
        results: [
          { index: 2, relevance_score: 0.99 },
          { index: 0, relevance_score: 0.5 },
          { index: 1, relevance_score: 0.1 },
        ],
      }),
    );
    const out = await rerank({ query: 'q', documents: ['a', 'b', 'c'] });
    expect(out).toEqual([
      { index: 2, relevanceScore: 0.99 },
      { index: 0, relevanceScore: 0.5 },
      { index: 1, relevanceScore: 0.1 },
    ]);
  });

  test('explicit input.model overrides gateway-configured model', async () => {
    let bodyModel = '';
    __setRerankTransportForTests(async (_url, init) => {
      bodyModel = JSON.parse(init.body as string).model;
      return mockResp({ results: [{ index: 0, relevance_score: 0.5 }] });
    });
    await rerank({ query: 'q', documents: ['d'], model: 'zeroentropyai:zerank-1-small' });
    expect(bodyModel).toBe('zerank-1-small');
  });

  test('empty documents returns [] without HTTP call', async () => {
    let called = false;
    __setRerankTransportForTests(async () => {
      called = true;
      return mockResp({ results: [] });
    });
    const out = await rerank({ query: 'q', documents: [] });
    expect(out).toEqual([]);
    expect(called).toBe(false);
  });
});

describe('gateway.rerank() — error classification', () => {
  beforeEach(() => configureZE());

  test('missing required reranker API key → RerankError(auth) before HTTP call', async () => {
    configureGateway({
      reranker_model: 'zeroentropyai:zerank-2',
      env: {},
    });
    let called = false;
    __setRerankTransportForTests(async () => {
      called = true;
      return mockResp({ results: [{ index: 0, relevance_score: 0.5 }] });
    });

    try {
      await rerank({ query: 'q', documents: ['d'] });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RerankError);
      expect((err as RerankError).reason).toBe('auth');
      expect((err as Error).message).toContain('ZEROENTROPY_API_KEY');
      expect(called).toBe(false);
    }
  });

  test('401 → auth', async () => {
    __setRerankTransportForTests(async () => new Response('Unauthorized', { status: 401 }));
    try {
      await rerank({ query: 'q', documents: ['d'] });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RerankError);
      expect((err as RerankError).reason).toBe('auth');
      expect((err as RerankError).status).toBe(401);
    }
  });

  test('403 → auth', async () => {
    __setRerankTransportForTests(async () => new Response('Forbidden', { status: 403 }));
    try {
      await rerank({ query: 'q', documents: ['d'] });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as RerankError).reason).toBe('auth');
    }
  });

  test('429 → rate_limit', async () => {
    __setRerankTransportForTests(async () => new Response('Rate limited', { status: 429 }));
    try {
      await rerank({ query: 'q', documents: ['d'] });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as RerankError).reason).toBe('rate_limit');
    }
  });

  test('500 → network', async () => {
    __setRerankTransportForTests(async () => new Response('Server error', { status: 500 }));
    try {
      await rerank({ query: 'q', documents: ['d'] });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as RerankError).reason).toBe('network');
    }
  });

  test('400 (non-classified) → unknown', async () => {
    __setRerankTransportForTests(async () => new Response('Bad request', { status: 400 }));
    try {
      await rerank({ query: 'q', documents: ['d'] });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as RerankError).reason).toBe('unknown');
    }
  });

  test('network exception (fetch reject) → network', async () => {
    __setRerankTransportForTests(async () => {
      throw new Error('ECONNREFUSED');
    });
    try {
      await rerank({ query: 'q', documents: ['d'] });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as RerankError).reason).toBe('network');
    }
  });

  test('malformed response (no results array) → unknown', async () => {
    __setRerankTransportForTests(async () => mockResp({ wrong_shape: true }));
    try {
      await rerank({ query: 'q', documents: ['d'] });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as RerankError).reason).toBe('unknown');
    }
  });
});

describe('gateway.rerank() — payload-too-large pre-flight (no HTTP call)', () => {
  beforeEach(() => configureZE());

  test('body over max_payload_bytes throws payload_too_large WITHOUT transport call', async () => {
    let called = false;
    __setRerankTransportForTests(async () => {
      called = true;
      return mockResp({ results: [] });
    });
    // ZE's max_payload_bytes is 5MB. 6MB body easily exceeds.
    const huge = 'x'.repeat(6 * 1024 * 1024);
    try {
      await rerank({ query: 'q', documents: [huge] });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RerankError);
      expect((err as RerankError).reason).toBe('payload_too_large');
      // CRITICAL: the guard must fire BEFORE the transport is called.
      // Otherwise applyReranker's fail-open would burn an HTTP round-trip.
      expect(called).toBe(false);
    }
  });

  test('body under cap proceeds normally', async () => {
    let called = false;
    __setRerankTransportForTests(async () => {
      called = true;
      return mockResp({ results: [{ index: 0, relevance_score: 0.5 }] });
    });
    const normal = 'doc'.repeat(100);
    await rerank({ query: 'q', documents: [normal] });
    expect(called).toBe(true);
  });
});

describe('gateway.rerank() — allowlist enforcement (CDX2-F11)', () => {
  test('rejects model not in recipe touchpoint.models[]', async () => {
    configureZE();
    let called = false;
    __setRerankTransportForTests(async () => {
      called = true;
      return mockResp({ results: [] });
    });
    try {
      await rerank({
        query: 'q',
        documents: ['d'],
        model: 'zeroentropyai:zerank-fake-99',
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RerankError);
      expect((err as RerankError).message).toContain('not listed');
      expect(called).toBe(false);
    }
  });

  test('accepts zerank-1 (legacy allowlist member)', async () => {
    configureZE();
    __setRerankTransportForTests(async () => mockResp({ results: [{ index: 0, relevance_score: 1 }] }));
    const out = await rerank({
      query: 'q',
      documents: ['d'],
      model: 'zeroentropyai:zerank-1',
    });
    expect(out.length).toBe(1);
  });

  test('rejects provider that does not declare reranker touchpoint', async () => {
    configureGateway({
      reranker_model: 'openai:gpt-fake',
      env: { OPENAI_API_KEY: 'sk-fake' },
    });
    try {
      await rerank({ query: 'q', documents: ['d'] });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RerankError);
      expect((err as RerankError).message).toContain('does not declare a reranker touchpoint');
    }
  });
});

describe('gateway.rerank() — guard rails', () => {
  beforeEach(() => configureZE());

  test('empty query throws RerankError(unknown)', async () => {
    try {
      await rerank({ query: '', documents: ['d'] });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RerankError);
      expect((err as RerankError).reason).toBe('unknown');
    }
  });
});

describe('gateway.rerank() — v0.40.6.1 RerankerTouchpoint.path override', () => {
  test('honors tp.path when recipe declares one (llama-server-reranker → /v1/rerank)', async () => {
    configureGateway({
      reranker_model: 'llama-server-reranker:qwen3-reranker-4b',
      env: {},
    });
    let capturedUrl = '';
    __setRerankTransportForTests(async (url) => {
      capturedUrl = url;
      return mockResp({ results: [{ index: 0, relevance_score: 0.8 }] });
    });
    await rerank({ query: 'q', documents: ['d'] });
    // Recipe `base_url_default` is `http://localhost:8081/v1` and the
    // touchpoint `path` is the LEAF `/rerank` — gateway must concatenate
    // them to `http://localhost:8081/v1/rerank` exactly. The codex
    // diff-review caught a /v1 path-doubling bug here that the prior
    // `endsWith('/v1/rerank')` assertion silently passed through; the
    // exact-equality assertion below is the regression guard.
    expect(capturedUrl).toBe('http://localhost:8081/v1/rerank');
    expect(capturedUrl).not.toContain('/v1/v1/');
    expect(capturedUrl).not.toContain('/models/rerank');
  });

  test('falls through to /models/rerank when recipe omits path (ZE regression)', async () => {
    configureZE();
    let capturedUrl = '';
    __setRerankTransportForTests(async (url) => {
      capturedUrl = url;
      return mockResp({ results: [{ index: 0, relevance_score: 0.9 }] });
    });
    await rerank({ query: 'q', documents: ['d'] });
    expect(capturedUrl).toBe('https://api.zeroentropy.dev/v1/models/rerank');
  });
});

describe('gateway.rerank() — v0.40.6.1 user-provided models (empty allowlist)', () => {
  test('empty models[] on the recipe accepts any model id', async () => {
    // llama-server-reranker declares `models: []` — anything goes.
    configureGateway({
      reranker_model: 'llama-server-reranker:some-custom-model-id',
      env: {},
    });
    let called = false;
    __setRerankTransportForTests(async () => {
      called = true;
      return mockResp({ results: [{ index: 0, relevance_score: 0.7 }] });
    });
    const out = await rerank({ query: 'q', documents: ['d'] });
    expect(called).toBe(true);
    expect(out.length).toBe(1);
  });

  test('still rejects empty models[] on a different model resolved via input.model', async () => {
    // Even when caller overrides via input.model, the resolved recipe still
    // governs the allowlist. Empty allowlist = no restriction.
    configureGateway({
      reranker_model: 'zeroentropyai:zerank-2',
      env: { ZEROENTROPY_API_KEY: 'sk-test' },
    });
    __setRerankTransportForTests(async () =>
      mockResp({ results: [{ index: 0, relevance_score: 0.6 }] }),
    );
    const out = await rerank({
      query: 'q',
      documents: ['d'],
      model: 'llama-server-reranker:whatever-id', // recipe with empty allowlist
    });
    expect(out.length).toBe(1);
  });
});

describe('gateway.rerank() — v0.40.6.1 path regression: zerank-1-small unaffected', () => {
  test('legacy ZE allowlist members still hit /models/rerank', async () => {
    configureZE('zeroentropyai:zerank-1-small');
    let capturedUrl = '';
    __setRerankTransportForTests(async (url) => {
      capturedUrl = url;
      return mockResp({ results: [{ index: 0, relevance_score: 0.5 }] });
    });
    await rerank({ query: 'q', documents: ['d'] });
    expect(capturedUrl.endsWith('/models/rerank')).toBe(true);
  });
});
