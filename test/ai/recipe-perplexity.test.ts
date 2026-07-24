/**
 * #1046 — Perplexity hosted embeddings (pplx-embed-v1-*).
 *
 * Covers the three seams the recipe touches:
 *  - recipe registration + auth (PERPLEXITY_API_KEY only, never OPENAI_API_KEY)
 *  - flexible-dim validation (128..native max) in dims.ts + the init
 *    preflight (resolveSchemaEmbeddingDim), incl. the >2000-dim 4b case
 *  - perplexityCompatFetch: forces encoding_format=base64_int8 outbound and
 *    decodes the base64 int8 embedding payload to number[] inbound
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  dimsProviderOptions,
  isPerplexityEmbeddingModel,
  isValidPerplexityDim,
  maxPerplexityEmbeddingDim,
} from '../../src/core/ai/dims.ts';
import { getRecipe, RECIPES } from '../../src/core/ai/recipes/index.ts';
import { perplexity } from '../../src/core/ai/recipes/perplexity.ts';
import { defaultResolveAuth, perplexityCompatFetch } from '../../src/core/ai/gateway.ts';
import { AIConfigError } from '../../src/core/ai/errors.ts';
import { resolveSchemaEmbeddingDim } from '../../src/core/embedding-dim-check.ts';
import { lookupEmbeddingPrice } from '../../src/core/embedding-pricing.ts';

describe('recipe: perplexity', () => {
  test('registered as an OpenAI-compatible embedding provider', () => {
    expect(RECIPES.has('perplexity')).toBe(true);
    expect(getRecipe('perplexity')).toBe(perplexity);
    expect(perplexity.tier).toBe('openai-compat');
    expect(perplexity.implementation).toBe('openai-compatible');
    expect(perplexity.base_url_default).toBe('https://api.perplexity.ai/v1');
    const e = perplexity.touchpoints.embedding!;
    expect(e.models).toEqual(['pplx-embed-v1-0.6b', 'pplx-embed-v1-4b']);
    expect(e.default_dims).toBe(1024);
    expect(e.max_batch_tokens).toBe(120_000);
  });

  test('auth is PERPLEXITY_API_KEY bearer — no OPENAI_API_KEY fallback', () => {
    expect(perplexity.resolveAuth).toBeUndefined();
    expect(perplexity.auth_env?.required).toEqual(['PERPLEXITY_API_KEY']);
    expect(defaultResolveAuth(perplexity, { PERPLEXITY_API_KEY: 'fake-pplx' }, 'embedding')).toEqual({
      headerName: 'Authorization',
      token: 'Bearer fake-pplx',
    });
    // An OPENAI_API_KEY in the env must NOT satisfy Perplexity auth.
    expect(() => defaultResolveAuth(perplexity, { OPENAI_API_KEY: 'sk-test' }, 'embedding')).toThrow(AIConfigError);
  });

  test('dims: 128..native-max range per model', () => {
    expect(isPerplexityEmbeddingModel('pplx-embed-v1-4b')).toBe(true);
    expect(maxPerplexityEmbeddingDim('pplx-embed-v1-4b')).toBe(2560);
    expect(maxPerplexityEmbeddingDim('pplx-embed-v1-0.6b')).toBe(1024);
    expect(isValidPerplexityDim('pplx-embed-v1-4b', 2560)).toBe(true);
    expect(isValidPerplexityDim('pplx-embed-v1-4b', 128)).toBe(true);
    expect(isValidPerplexityDim('pplx-embed-v1-4b', 64)).toBe(false);
    expect(isValidPerplexityDim('pplx-embed-v1-0.6b', 2560)).toBe(false);
  });

  test('dimsProviderOptions emits native `dimensions`, fails loud out of range', () => {
    expect(dimsProviderOptions('openai-compatible', 'pplx-embed-v1-4b', 2560)).toEqual({
      openaiCompatible: { dimensions: 2560 },
    });
    // Symmetric provider — inputType never emitted.
    expect(dimsProviderOptions('openai-compatible', 'pplx-embed-v1-4b', 1024, 'query')).toEqual({
      openaiCompatible: { dimensions: 1024 },
    });
    expect(() => dimsProviderOptions('openai-compatible', 'pplx-embed-v1-0.6b', 2560)).toThrow(AIConfigError);
  });

  test('init preflight accepts the 4b model at its native 2560 dims (halfvec territory)', () => {
    const res = resolveSchemaEmbeddingDim({
      embedding_model: 'perplexity:pplx-embed-v1-4b',
      embedding_dimensions: 2560,
    });
    expect(res).toEqual({
      ok: true,
      dim: 2560,
      model: 'perplexity:pplx-embed-v1-4b',
      provider: 'perplexity',
      recipeDefault: 1024,
    });
    const bad = resolveSchemaEmbeddingDim({
      embedding_model: 'perplexity:pplx-embed-v1-4b',
      embedding_dimensions: 4096,
    });
    expect(bad.ok).toBe(false);
  });

  test('embedding pricing table knows both models', () => {
    expect(lookupEmbeddingPrice('perplexity:pplx-embed-v1-4b')).toMatchObject({ kind: 'known', pricePerMTok: 0.03 });
    expect(lookupEmbeddingPrice('perplexity:pplx-embed-v1-0.6b')).toMatchObject({ kind: 'known', pricePerMTok: 0.004 });
  });
});

describe('perplexityCompatFetch — int8 wire shim', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test('forces encoding_format=base64_int8 outbound and decodes int8 base64 inbound', async () => {
    const int8 = new Int8Array([3, -7, 127, -128]);
    const b64 = Buffer.from(int8.buffer).toString('base64');
    let sentBody: any;
    globalThis.fetch = (async (_input: any, init?: RequestInit) => {
      sentBody = JSON.parse(init!.body as string);
      return new Response(
        JSON.stringify({
          object: 'list',
          model: 'pplx-embed-v1-4b',
          data: [{ object: 'embedding', index: 0, embedding: b64 }],
          usage: { prompt_tokens: 4, total_tokens: 4 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as any;

    const resp = await (perplexityCompatFetch as any)('https://api.perplexity.ai/v1/embeddings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // The AI SDK sends encoding_format:'float' — Perplexity rejects it.
      body: JSON.stringify({ model: 'pplx-embed-v1-4b', input: ['hi'], encoding_format: 'float', dimensions: 4 }),
    });

    expect(sentBody.encoding_format).toBe('base64_int8');
    expect(sentBody.dimensions).toBe(4); // native field, untouched
    const json = await resp.json();
    expect(json.data[0].embedding).toEqual([3, -7, 127, -128]);
    expect(json.usage.prompt_tokens).toBe(4);
  });

  test('non-JSON and error responses pass through untouched', async () => {
    globalThis.fetch = (async () =>
      new Response('nope', { status: 401, headers: { 'content-type': 'text/plain' } })) as any;
    const resp = await (perplexityCompatFetch as any)('https://api.perplexity.ai/v1/embeddings', {
      method: 'POST',
      body: JSON.stringify({ model: 'pplx-embed-v1-4b', input: ['hi'] }),
    });
    expect(resp.status).toBe(401);
    expect(await resp.text()).toBe('nope');
  });
});
