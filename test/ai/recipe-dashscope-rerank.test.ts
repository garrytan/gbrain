/**
 * dashscope-rerank recipe smoke.
 *
 * Sibling of recipe-llama-server-reranker.test.ts. Pins the recipe shape so:
 *  - id + tier + implementation + base_url stay byte-stable
 *  - reranker touchpoint declares the PLURAL `/reranks` leaf (the whole
 *    reason this recipe exists — DashScope's compatible-api surface 404s
 *    on singular `/rerank`) + `default_timeout_ms`
 *  - only live-verified models are listed (gte-rerank-v2 is native-API only
 *    and rejected by the OpenAI-compat surface)
 */

import { describe, expect, test } from 'bun:test';
import { getRecipe } from '../../src/core/ai/recipes/index.ts';
import { defaultResolveAuth } from '../../src/core/ai/gateway.ts';
import { AIConfigError } from '../../src/core/ai/errors.ts';

describe('recipe: dashscope-rerank', () => {
  test('registered with expected shape', () => {
    const r = getRecipe('dashscope-rerank');
    expect(r).toBeDefined();
    expect(r!.id).toBe('dashscope-rerank');
    expect(r!.tier).toBe('openai-compat');
    expect(r!.implementation).toBe('openai-compatible');
    expect(r!.base_url_default).toBe(
      'https://dashscope-intl.aliyuncs.com/compatible-api/v1',
    );
    expect(r!.auth_env?.required).toEqual(['DASHSCOPE_API_KEY']);
  });

  test('declares reranker touchpoint with PLURAL /reranks path + timeout', () => {
    const r = getRecipe('dashscope-rerank')!;
    const tp = r.touchpoints.reranker;
    expect(tp).toBeDefined();
    expect(tp!.path).toBe('/reranks');
    expect(tp!.default_timeout_ms).toBe(30_000);
    expect(tp!.max_payload_bytes).toBe(5_000_000);
  });

  test('base_url + path concatenation produces /v1/reranks, NOT /v1/v1/…', () => {
    const r = getRecipe('dashscope-rerank')!;
    const combined =
      r.base_url_default!.replace(/\/$/, '') + (r.touchpoints.reranker!.path ?? '/models/rerank');
    expect(combined).toBe('https://dashscope-intl.aliyuncs.com/compatible-api/v1/reranks');
    expect(combined).not.toContain('/v1/v1/');
    expect(combined.endsWith('/reranks')).toBe(true);
  });

  test('lists only the live-verified compat-surface model', () => {
    const r = getRecipe('dashscope-rerank')!;
    const tp = r.touchpoints.reranker!;
    expect(tp.models).toEqual(['qwen3-rerank']);
    expect(tp.default_model).toBe('qwen3-rerank');
    // gte-rerank-v2 is native-API only; the compat surface rejects it.
    expect(tp.models).not.toContain('gte-rerank-v2');
  });

  test('default auth: DASHSCOPE_API_KEY set → Bearer token', () => {
    const r = getRecipe('dashscope-rerank')!;
    const auth = defaultResolveAuth(
      r,
      { DASHSCOPE_API_KEY: 'sk-dashscope-fake' },
      'reranker',
    );
    expect(auth.headerName).toBe('Authorization');
    expect(auth.token).toBe('Bearer sk-dashscope-fake');
  });

  test('default auth: missing DASHSCOPE_API_KEY → AIConfigError', () => {
    const r = getRecipe('dashscope-rerank')!;
    expect(() => defaultResolveAuth(r, {}, 'reranker')).toThrow(AIConfigError);
  });

  test('does not perturb the sibling dashscope embedding recipe', () => {
    const emb = getRecipe('dashscope')!;
    expect(emb.base_url_default).toBe('https://dashscope-intl.aliyuncs.com/compatible-mode/v1');
    expect(emb.touchpoints.reranker).toBeUndefined();
  });
});
