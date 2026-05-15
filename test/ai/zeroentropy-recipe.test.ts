/**
 * v0.33.2+ ZeroEntropy recipe shape tests. Pins the contracts Codex
 * Round 1 + 2 flagged in the plan-review wave:
 *
 *  - F1: implementation MUST be 'openai-compatible' (not the misspelled
 *    'openai-compat' the original plan draft had).
 *  - F2: base_url_default MUST end with '/v1' so the gateway's
 *    URL-rewrite path replaces /embeddings → /models/embed cleanly.
 *  - reranker touchpoint declared with correct allowlist + payload cap.
 */

import { describe, test, expect } from 'bun:test';
import { zeroentropyai } from '../../src/core/ai/recipes/zeroentropyai.ts';
import { RECIPES, getRecipe } from '../../src/core/ai/recipes/index.ts';

describe('zeroentropyai recipe shape', () => {
  test('F1 regression — implementation literal is "openai-compatible"', () => {
    // CDX1-F1: the original plan had 'openai-compat' which is not a valid
    // Implementation literal. This assertion fails loud if a future PR
    // re-introduces the typo.
    expect(zeroentropyai.implementation).toBe('openai-compatible');
  });

  test('F2 regression — base_url_default ends with /v1', () => {
    // CDX1-F2: when /embeddings → /models/embed rewrite fires, the final
    // URL must be …/v1/models/embed (NOT …/v1/v1/…). The recipe's base URL
    // already includes /v1, so the rewrite is a plain path substitution.
    expect(zeroentropyai.base_url_default).toBe('https://api.zeroentropy.dev/v1');
    expect(zeroentropyai.base_url_default!.endsWith('/v1')).toBe(true);
  });

  test('registered in ALL[] via index.ts', () => {
    expect(RECIPES.has('zeroentropyai')).toBe(true);
    expect(getRecipe('zeroentropyai')).toBe(zeroentropyai);
  });

  test('embedding touchpoint declares zembed-1 with 7 flexible dims', () => {
    const e = zeroentropyai.touchpoints.embedding!;
    expect(e.models).toEqual(['zembed-1']);
    expect(e.default_dims).toBe(2560);
    expect(e.supports_multimodal).toBe(false);
    // Dense-payload hedge matches Voyage (CJK / JSON / code overshoot tiktoken).
    expect(e.chars_per_token).toBe(1);
    expect(e.safety_factor).toBe(0.5);
    expect(e.max_batch_tokens).toBe(120_000);
  });

  test('reranker touchpoint declares zerank-2 + zerank-1 + zerank-1-small', () => {
    const r = zeroentropyai.touchpoints.reranker!;
    expect(r).toBeDefined();
    expect(r.models).toContain('zerank-2');
    expect(r.models).toContain('zerank-1');
    expect(r.models).toContain('zerank-1-small');
    expect(r.default_model).toBe('zerank-2');
    expect(r.max_payload_bytes).toBe(5_000_000); // ZE's per-request cap.
  });

  test('auth_env declares ZEROENTROPY_API_KEY + setup URL', () => {
    expect(zeroentropyai.auth_env!.required).toEqual(['ZEROENTROPY_API_KEY']);
    expect(zeroentropyai.auth_env!.setup_url).toBe('https://dashboard.zeroentropy.dev');
  });
});
