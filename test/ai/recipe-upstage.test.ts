/**
 * Upstage Solar Embeddings recipe smoke.
 *
 * Upstage exposes Solar embeddings at an OpenAI-compatible wire shape under
 * /v1/solar/embeddings. The model family is asymmetric: documents should use
 * solar-embedding-1-large-passage while search queries should use
 * solar-embedding-1-large-query. Both return 4096-dim vectors in the same
 * embedding space.
 */

import { describe, expect, test } from 'bun:test';
import { getRecipe, RECIPES } from '../../src/core/ai/recipes/index.ts';
import { defaultResolveAuth } from '../../src/core/ai/gateway.ts';
import { dimsProviderOptions } from '../../src/core/ai/dims.ts';
import { AIConfigError } from '../../src/core/ai/errors.ts';

describe('recipe: upstage', () => {
  test('registered with expected OpenAI-compatible endpoint shape', () => {
    const r = getRecipe('upstage');
    expect(r).toBeDefined();
    expect(RECIPES.has('upstage')).toBe(true);
    expect(r!.id).toBe('upstage');
    expect(r!.name).toBe('Upstage');
    expect(r!.tier).toBe('openai-compat');
    expect(r!.implementation).toBe('openai-compatible');
    expect(r!.base_url_default).toBe('https://api.upstage.ai/v1/solar');
    expect(r!.auth_env?.required).toEqual(['UPSTAGE_API_KEY']);
    expect(r!.auth_env?.setup_url).toBe('https://console.upstage.ai/api-keys');
  });

  test('embedding touchpoint declares Solar query/passage pair at 4096 dims', () => {
    const e = getRecipe('upstage')!.touchpoints.embedding!;
    expect(e.models[0]).toBe('solar-embedding-1-large-passage');
    expect(e.models).toContain('solar-embedding-1-large-query');
    expect(e.default_dims).toBe(4096);
    expect(e.dims_options).toEqual([4096]);
    expect(e.max_batch_tokens).toBeGreaterThan(0);
    expect(e.chars_per_token).toBeGreaterThan(0);
  });

  test('default auth: UPSTAGE_API_KEY set → "Bearer <key>"', () => {
    const r = getRecipe('upstage')!;
    const auth = defaultResolveAuth(r, { UPSTAGE_API_KEY: '***' }, 'embedding');
    expect(auth.headerName).toBe('Authorization');
    expect(auth.token).toBe('Bearer ***');
  });

  test('default auth: missing UPSTAGE_API_KEY → AIConfigError', () => {
    const r = getRecipe('upstage')!;
    expect(() => defaultResolveAuth(r, {}, 'embedding')).toThrow(AIConfigError);
  });

  test('dimsProviderOptions threads query/document side for Solar pair but no dimensions param', () => {
    expect(dimsProviderOptions('openai-compatible', 'solar-embedding-1-large-passage', 4096))
      .toEqual({ openaiCompatible: { input_type: 'document' } });
    expect(dimsProviderOptions('openai-compatible', 'solar-embedding-1-large-passage', 4096, 'query'))
      .toEqual({ openaiCompatible: { input_type: 'query' } });
    expect(dimsProviderOptions('openai-compatible', 'solar-embedding-1-large-query', 4096, 'query'))
      .toEqual({ openaiCompatible: { input_type: 'query' } });
  });

  test('dimsProviderOptions fail-louds if Solar is configured away from 4096 dims', () => {
    expect(() => dimsProviderOptions('openai-compatible', 'solar-embedding-1-large-passage', 1536))
      .toThrow(AIConfigError);
  });
});
