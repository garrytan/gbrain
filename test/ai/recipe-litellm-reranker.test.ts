/**
 * litellm-proxy reranker touchpoint smoke.
 *
 * Sibling of recipe-llama-server-reranker.test.ts. Pins the reranker touchpoint
 * added to the LiteLLM proxy recipe so:
 *  - the touchpoint exists with the `/v1/rerank` leaf path the gateway needs
 *  - base_url ('http://localhost:4000', no /v1) + path concatenate to a single
 *    '/v1/rerank' (no doubled prefix)
 *  - models: [] (user-provided; proxy defines the model ids)
 *  - cost_per_1m_tokens_usd: 0 so BudgetTracker doesn't hard-fail at the recipe
 *    layer (the proxied provider bills, not gbrain)
 */

import { describe, expect, test } from 'bun:test';
import { getRecipe } from '../../src/core/ai/recipes/index.ts';

describe('recipe: litellm reranker touchpoint', () => {
  test('declares reranker touchpoint with /v1/rerank path', () => {
    const r = getRecipe('litellm')!;
    const tp = r.touchpoints.reranker;
    expect(tp).toBeDefined();
    expect(tp!.path).toBe('/v1/rerank');
    expect(tp!.cost_per_1m_tokens_usd).toBe(0);
    expect(tp!.max_payload_bytes).toBe(5_000_000);
  });

  test('base_url + path concatenation produces /v1/rerank, NOT /v1/v1/rerank', () => {
    const r = getRecipe('litellm')!;
    const combined =
      r.base_url_default!.replace(/\/$/, '') + (r.touchpoints.reranker!.path ?? '/models/rerank');
    expect(combined).toBe('http://localhost:4000/v1/rerank');
    expect(combined).not.toContain('/v1/v1/');
  });

  test('reranker touchpoint uses empty models[] for user-provided model ids', () => {
    const r = getRecipe('litellm')!;
    expect(r.touchpoints.reranker!.models).toEqual([]);
  });
});
