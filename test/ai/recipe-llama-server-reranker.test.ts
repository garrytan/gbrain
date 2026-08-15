/**
 * llama-server-reranker recipe smoke (v0.40.6.1).
 *
 * Sibling of recipe-llama-server.test.ts. Pins the recipe shape so:
 *  - id + tier + implementation + base_url stay byte-stable
 *  - reranker touchpoint declares the v0.40.6.1 `path` + `default_timeout_ms`
 *    fields that the gateway + mode resolution depend on
 *  - models: [] (user-provided), with realistic default_model placeholder
 *  - env vars LLAMA_SERVER_RERANKER_BASE_URL + _API_KEY are declared optional
 *  - cost_per_1m_tokens_usd: 0 so BudgetTracker's FREE_LOCAL_RERANK_PROVIDERS
 *    contract holds at the recipe layer
 */

import { describe, expect, test } from 'bun:test';
import { getRecipe } from '../../src/core/ai/recipes/index.ts';

describe('recipe: llama-server-reranker', () => {
  test('registered with expected shape', () => {
    const r = getRecipe('llama-server-reranker');
    expect(r).toBeDefined();
    expect(r!.id).toBe('llama-server-reranker');
    expect(r!.tier).toBe('openai-compat');
    expect(r!.implementation).toBe('openai-compatible');
    expect(r!.base_url_default).toBe('http://localhost:8081/v1');
  });

  test('declares the required + optional env vars', () => {
    const r = getRecipe('llama-server-reranker')!;
    expect(r.auth_env?.required ?? []).toEqual([]);
    expect(r.auth_env?.optional ?? []).toContain('LLAMA_SERVER_RERANKER_BASE_URL');
    expect(r.auth_env?.optional ?? []).toContain('LLAMA_SERVER_RERANKER_API_KEY');
  });

  test('declares reranker touchpoint with path + default_timeout_ms (v0.40.6.1)', () => {
    const r = getRecipe('llama-server-reranker')!;
    const tp = r.touchpoints.reranker;
    expect(tp).toBeDefined();
    // Leaf-only path; gateway concatenates with base_url's `/v1` prefix
    // to produce `…/v1/rerank`. The codex diff-review caught the original
    // `/v1/rerank` shape here that would have doubled the prefix.
    expect(tp!.path).toBe('/rerank');
    expect(tp!.default_timeout_ms).toBe(30_000);
  });

  test('base_url + path concatenation produces /v1/rerank, NOT /v1/v1/rerank', () => {
    // Direct shape check: regardless of how the gateway URL builder
    // handles concatenation, the recipe's two URL-building inputs must
    // produce a single `/v1` prefix when combined. Pins the codex-found
    // regression at the recipe layer in addition to the gateway test.
    const r = getRecipe('llama-server-reranker')!;
    const combined =
      r.base_url_default!.replace(/\/$/, '') + (r.touchpoints.reranker!.path ?? '/models/rerank');
    expect(combined).toBe('http://localhost:8081/v1/rerank');
    expect(combined).not.toContain('/v1/v1/');
  });

  test('reranker touchpoint uses empty models[] for user-provided model ids', () => {
    const r = getRecipe('llama-server-reranker')!;
    const tp = r.touchpoints.reranker!;
    expect(tp.models).toEqual([]);
    // default_model is informational placeholder for docs/wizard — real
    // id is whatever the user passes to --alias at server launch.
    expect(typeof tp.default_model).toBe('string');
    expect(tp.default_model.length).toBeGreaterThan(0);
  });

  test('cost is zero so BudgetTracker FREE_LOCAL_RERANK_PROVIDERS contract holds', () => {
    const r = getRecipe('llama-server-reranker')!;
    expect(r.touchpoints.reranker!.cost_per_1m_tokens_usd).toBe(0);
  });

  test('max_payload_bytes matches the upstream 5MB ceiling', () => {
    const r = getRecipe('llama-server-reranker')!;
    expect(r.touchpoints.reranker!.max_payload_bytes).toBe(5_000_000);
  });

  test('setup_hint mentions --alias (paste-ready UX)', () => {
    const r = getRecipe('llama-server-reranker')!;
    expect(r.setup_hint).toMatch(/--alias/);
    expect(r.setup_hint).toMatch(/--reranking/);
  });
});
