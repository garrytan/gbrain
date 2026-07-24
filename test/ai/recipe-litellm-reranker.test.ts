/**
 * litellm-proxy reranker touchpoint smoke.
 *
 * Sibling of recipe-llama-server-reranker.test.ts. Pins the reranker
 * touchpoint on the LiteLLM proxy recipe so:
 *  - the touchpoint exists with the LEAF '/rerank' path (LiteLLM serves both
 *    /rerank and /v1/rerank, so the leaf form is valid whether or not the
 *    user's LITELLM_BASE_URL carries the /v1 suffix the setup_hint allows)
 *  - a /v1-suffixed base URL does NOT produce /v1/v1/rerank (the original
 *    community PR pinned '/v1/rerank' which 404s on /v1-suffixed bases)
 *  - models: [] (user-provided; proxy defines the model ids)
 *  - pricing stays undefined (proxy can front a paid provider — same honest
 *    pricing-unknown stance as the embedding/chat touchpoints)
 *
 * The gateway.rerank() URL tests drive the real URL builder via the stubbed
 * transport (same seam as test/ai/rerank.test.ts).
 */

import { describe, expect, test, afterEach } from 'bun:test';
import { getRecipe } from '../../src/core/ai/recipes/index.ts';
import {
  configureGateway,
  resetGateway,
  rerank,
  __setRerankTransportForTests,
} from '../../src/core/ai/gateway.ts';

afterEach(() => {
  __setRerankTransportForTests(null);
  resetGateway();
});

describe('recipe: litellm reranker touchpoint', () => {
  test('declares reranker touchpoint with leaf /rerank path', () => {
    const r = getRecipe('litellm')!;
    const tp = r.touchpoints.reranker;
    expect(tp).toBeDefined();
    expect(tp!.path).toBe('/rerank');
    expect(tp!.max_payload_bytes).toBe(5_000_000);
  });

  test('reranker touchpoint uses empty models[] for user-provided model ids', () => {
    const r = getRecipe('litellm')!;
    expect(r.touchpoints.reranker!.models).toEqual([]);
  });

  test('pricing stays undefined — proxy can front a paid provider', () => {
    const r = getRecipe('litellm')!;
    expect(r.touchpoints.reranker!.cost_per_1m_tokens_usd).toBeUndefined();
  });

  test('setup_hint keeps the /v1-suffix guidance AND mentions rerank', () => {
    const r = getRecipe('litellm')!;
    expect(r.setup_hint).toMatch(/\/v1 suffix/);
    expect(r.setup_hint).toMatch(/search\.reranker\.model litellm:/);
  });
});

describe('gateway.rerank() URL via litellm recipe', () => {
  async function capturedRerankUrl(baseUrl?: string): Promise<string> {
    configureGateway({
      reranker_model: 'litellm:my-reranker',
      env: {},
      ...(baseUrl ? { base_urls: { litellm: baseUrl } } : {}),
    });
    let capturedUrl = '';
    __setRerankTransportForTests(async (url) => {
      capturedUrl = url;
      return new Response(
        JSON.stringify({ results: [{ index: 0, relevance_score: 0.9 }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    await rerank({ query: 'q', documents: ['d'] });
    return capturedUrl;
  }

  test('default base (no /v1 suffix) → /rerank', async () => {
    const url = await capturedRerankUrl();
    expect(url).toBe('http://localhost:4000/rerank');
  });

  test('/v1-suffixed base → /v1/rerank, NOT /v1/v1/rerank', async () => {
    const url = await capturedRerankUrl('http://localhost:4000/v1');
    expect(url).toBe('http://localhost:4000/v1/rerank');
    expect(url).not.toContain('/v1/v1/');
  });
});
