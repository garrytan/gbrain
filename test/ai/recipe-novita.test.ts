/**
 * Novita AI recipe smoke.
 */

import { describe, expect, test } from 'bun:test';
import { getRecipe } from '../../src/core/ai/recipes/index.ts';
import { defaultResolveAuth } from '../../src/core/ai/gateway.ts';
import { AIConfigError } from '../../src/core/ai/errors.ts';
import { lookupEmbeddingPrice } from '../../src/core/embedding-pricing.ts';

describe('recipe: novita', () => {
  test('registered with expected OpenAI-compatible shape', () => {
    const r = getRecipe('novita');
    expect(r).toBeDefined();
    expect(r!.id).toBe('novita');
    expect(r!.tier).toBe('openai-compat');
    expect(r!.implementation).toBe('openai-compatible');
    expect(r!.base_url_default).toBe('https://api.novita.ai/openai/v1');
    expect(r!.auth_env?.required).toEqual(['NOVITA_API_KEY']);
  });

  test('embedding touchpoint declares the documented bge-m3 model + fixed dims', () => {
    const e = getRecipe('novita')!.touchpoints.embedding;
    expect(e).toBeDefined();
    expect(e!.models).toEqual(['baai/bge-m3']);
    expect(e!.default_dims).toBe(1024);
    // BGE-M3 is fixed-dim (no Matryoshka truncation); no dims_options declared.
    expect(e!.dims_options).toBeUndefined();
  });

  test('embedding model resolves to a known price', () => {
    expect(lookupEmbeddingPrice('novita:baai/bge-m3').kind).toBe('known');
  });

  test('default auth: NOVITA_API_KEY set -> Bearer token', () => {
    const r = getRecipe('novita')!;
    const auth = defaultResolveAuth(r, { NOVITA_API_KEY: 'fake-novita-key' }, 'embedding');
    expect(auth.headerName).toBe('Authorization');
    expect(auth.token).toBe('Bearer fake-novita-key');
  });

  test('default auth: missing NOVITA_API_KEY -> AIConfigError', () => {
    const r = getRecipe('novita')!;
    expect(() => defaultResolveAuth(r, {}, 'embedding')).toThrow(AIConfigError);
  });
});
