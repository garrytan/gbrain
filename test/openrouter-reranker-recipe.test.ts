import { describe, test, expect } from 'bun:test';
import { getRecipe } from '../src/core/ai/recipes/index.ts';

describe('OpenRouter recipe — reranker touchpoint', () => {
  test('declares a reranker touchpoint', () => {
    const r = getRecipe('openrouter');
    expect(r).toBeDefined();
    expect(r!.touchpoints.reranker).toBeDefined();
  });

  test('models list includes all supported IDs (incl. NVIDIA :free suffix)', () => {
    const m = getRecipe('openrouter')!.touchpoints.reranker!.models;
    expect(m).toContain('cohere/rerank-v3.5');
    expect(m).toContain('cohere/rerank-4-fast');
    expect(m).toContain('cohere/rerank-4-pro');
    // The :free suffix must appear in full — gateway.rerank() does exact
    // string matching against the allowlist (no v0.31.12 extended-model bypass
    // on the rerank path), so truncating to `nvidia/.../v2` would 403.
    expect(m).toContain('nvidia/llama-nemotron-rerank-vl-1b-v2:free');
    expect(m).toContain('voyageai/rerank-2.5-lite');
    expect(m).toContain('voyageai/rerank-2.5');
  });

  test('default_model is cohere/rerank-v3.5', () => {
    const tp = getRecipe('openrouter')!.touchpoints.reranker!;
    expect(tp.default_model).toBe('cohere/rerank-v3.5');
    expect(tp.models).toContain(tp.default_model);
  });

  test('path is /rerank (NOT ZeroEntropy default /models/rerank)', () => {
    const tp = getRecipe('openrouter')!.touchpoints.reranker!;
    expect(tp.path).toBe('/rerank');
  });

  test('max_payload_bytes and timeout match plan', () => {
    const tp = getRecipe('openrouter')!.touchpoints.reranker!;
    expect(tp.max_payload_bytes).toBe(5_000_000);
    expect(tp.default_timeout_ms).toBe(5_000);
  });

  test('declares mixed billing without a misleading touchpoint token rate', () => {
    const tp = getRecipe('openrouter')!.touchpoints.reranker!;
    expect(tp.billing_unit).toBe('mixed');
    expect(tp.cost_per_1m_tokens_usd).toBeUndefined();
  });

  test('declares exact per-model pricing for Voyage and the free NVIDIA route', () => {
    const costs = getRecipe('openrouter')!.touchpoints.reranker!.model_cost_per_1m_tokens_usd;
    expect(costs).toEqual({
      'voyageai/rerank-2.5-lite': 0.02,
      'voyageai/rerank-2.5': 0.05,
      'nvidia/llama-nemotron-rerank-vl-1b-v2:free': 0,
    });
  });
});
