/**
 * Mistral recipe shape tests. Mistral's /v1/embeddings is OpenAI-shaped on the
 * response, so it ships as a pure openai-compatible provider (file + register,
 * no gateway shim) per the rule in src/core/ai/recipes/index.ts.
 *
 * Pins:
 *  - implementation literal is 'openai-compatible' (not the 'openai-compat' typo).
 *  - registered in ALL[] via index.ts.
 *  - codestral-embed declared at 1536 default dims, text-only.
 *  - pricing entries resolve for both the alias and dated model ids.
 */

import { describe, test, expect } from 'bun:test';
import { mistral } from '../../src/core/ai/recipes/mistral.ts';
import { RECIPES, getRecipe } from '../../src/core/ai/recipes/index.ts';
import { lookupEmbeddingPrice } from '../../src/core/embedding-pricing.ts';

describe('mistral recipe shape', () => {
  test('implementation literal is "openai-compatible"', () => {
    expect(mistral.implementation).toBe('openai-compatible');
  });

  test('base_url_default points at Mistral v1', () => {
    expect(mistral.base_url_default).toBe('https://api.mistral.ai/v1');
  });

  test('registered in ALL[] via index.ts', () => {
    expect(RECIPES.has('mistral')).toBe(true);
    expect(getRecipe('mistral')).toBe(mistral);
  });

  test('embedding touchpoint declares codestral-embed at 1536 dims, text-only', () => {
    const e = mistral.touchpoints.embedding!;
    expect(e.models).toContain('codestral-embed');
    expect(e.models).toContain('codestral-embed-2505');
    expect(e.default_dims).toBe(1536);
    expect(e.supports_multimodal).toBe(false);
    // Dense-content (code) batch hedge.
    expect(e.chars_per_token).toBe(3);
    expect(e.safety_factor).toBe(0.5);
    expect(e.max_batch_tokens).toBe(16_384);
  });

  test('auth_env declares MISTRAL_API_KEY + setup URL', () => {
    expect(mistral.auth_env!.required).toEqual(['MISTRAL_API_KEY']);
    expect(mistral.auth_env!.setup_url).toBe('https://console.mistral.ai/api-keys');
  });

  test('pricing resolves for both alias and dated model ids', () => {
    const alias = lookupEmbeddingPrice('mistral:codestral-embed');
    const dated = lookupEmbeddingPrice('mistral:codestral-embed-2505');
    expect(alias.kind).toBe('known');
    expect(dated.kind).toBe('known');
    if (alias.kind === 'known') expect(alias.pricePerMTok).toBe(0.15);
    if (dated.kind === 'known') expect(dated.pricePerMTok).toBe(0.15);
  });
});
