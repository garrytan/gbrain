/**
 * OrcaRouter recipe smoke.
 *
 * The load-bearing assertions here are the negative ones. OrcaRouter is a
 * nested-id gateway like OpenRouter, so the obvious move when extending it
 * later is to copy openrouter.ts's extras across. Three of them do NOT apply,
 * and each was a live measurement rather than an omission:
 *
 *  - no reranker touchpoint (the gateway routes no rerank models),
 *  - no prompt-cache support (cache_control creates no cache entry),
 *  - no compat fetch (nothing for one to rewrite, given the above).
 *
 * These pin that, so a future "make it match OpenRouter" edit fails here
 * instead of shipping a marker header for a rewrite that buys nothing.
 */

import { describe, expect, test } from 'bun:test';
import { getRecipe } from '../../src/core/ai/recipes/index.ts';
import { defaultResolveAuth } from '../../src/core/ai/gateway.ts';
import { assertTouchpoint, parseModelId } from '../../src/core/ai/model-resolver.ts';
import { AIConfigError } from '../../src/core/ai/errors.ts';
import { dimsProviderOptions } from '../../src/core/ai/dims.ts';
import { lookupEmbeddingPrice } from '../../src/core/embedding-pricing.ts';

describe('recipe: orcarouter', () => {
  test('registered with expected OpenAI-compatible shape', () => {
    const r = getRecipe('orcarouter');
    expect(r).toBeDefined();
    expect(r!.id).toBe('orcarouter');
    expect(r!.tier).toBe('openai-compat');
    expect(r!.implementation).toBe('openai-compatible');
    expect(r!.base_url_default).toBe('https://api.orcarouter.ai/v1');
    expect(r!.auth_env?.required).toEqual(['ORCAROUTER_API_KEY']);
    expect(r!.auth_env?.optional).toContain('ORCAROUTER_BASE_URL');
  });

  test('nested provider/model ids resolve like OpenRouter (colon wins over slash)', () => {
    // The whole reason no model-resolver change was needed.
    const parsed = parseModelId('orcarouter:anthropic/claude-sonnet-4.6');
    expect(parsed.providerId).toBe('orcarouter');
    expect(parsed.modelId).toBe('anthropic/claude-sonnet-4.6');
  });

  test('embedding touchpoint pins 1536 dims and the measured 300K batch ceiling', () => {
    const e = getRecipe('orcarouter')!.touchpoints.embedding;
    expect(e).toBeDefined();
    expect(e!.models).toContain('openai/text-embedding-3-small');
    expect(e!.default_dims).toBe(1536);
    // Measured, not inherited: a 300K-token batch is accepted; larger returns
    // 400 max_tokens_per_request "max 300000 tokens per request".
    expect(e!.max_batch_tokens).toBe(300_000);
    expect(e!.dims_options).toEqual([512, 768, 1024, 1536]);
  });

  test('the nested embedding id still emits a Matryoshka dimensions field', () => {
    // dimsProviderOptions strips the `provider/` prefix before matching
    // text-embedding-3*, which is why no dims.ts change was needed. If that
    // prefix-stripping is ever removed, this fails instead of silently
    // embedding at the native 1536 into a 512-wide column.
    expect(
      dimsProviderOptions('openai-compatible', 'openai/text-embedding-3-small', 512),
    ).toEqual({ openaiCompatible: { dimensions: 512 } });
  });

  test('an out-of-range dimension fails loud rather than at first embed', () => {
    // text-embedding-3-small tops out at 1536.
    expect(() =>
      dimsProviderOptions('openai-compatible', 'openai/text-embedding-3-small', 4096),
    ).toThrow(AIConfigError);
  });

  test('the listed embedding model resolves to a known price', () => {
    // An unknown price makes the embedding spend cap fail closed.
    expect(lookupEmbeddingPrice('orcarouter:openai/text-embedding-3-small').kind).toBe('known');
  });

  test('NEGATIVE: no reranker touchpoint', () => {
    // POST /rerank with cohere/rerank-v3.5 returns 503 model_not_found, and no
    // catalog id matches /rerank/. Copying openrouter.ts's reranker block would
    // make gateway.rerank() route here and fail at request time.
    expect(getRecipe('orcarouter')!.touchpoints.reranker).toBeUndefined();
  });

  test('NEGATIVE: prompt caching is not claimed, and there is no compat fetch', () => {
    const r = getRecipe('orcarouter')!;
    // Probed on both families with a >4K-token prefix sent twice: the Anthropic
    // route with a `cache_control` breakpoint reported
    // claude_cache_creation_5_m_tokens=0 / cached_tokens=0, and the OpenAI
    // route (auto-caching upstream) reported cached_tokens=0 on the repeat.
    expect(r.touchpoints.chat!.supports_prompt_cache).toBe(false);
    // No cache_control rewrite to perform, so no fetch shim — unlike openrouter.
    expect(r.compat?.fetch).toBeUndefined();
  });

  test('chat and expansion touchpoints accept their configured models', () => {
    const r = getRecipe('orcarouter')!;
    expect(r.touchpoints.chat!.supports_tools).toBe(true);
    expect(r.touchpoints.chat!.supports_subagent_loop).toBe(false);
    expect(() => assertTouchpoint(r, 'chat', 'openai/gpt-5.5')).not.toThrow();
    expect(() => assertTouchpoint(r, 'chat', 'anthropic/claude-sonnet-4.6')).not.toThrow();
    expect(() => assertTouchpoint(r, 'expansion', 'anthropic/claude-haiku-4.5')).not.toThrow();
    expect(() => assertTouchpoint(r, 'embedding', 'openai/text-embedding-3-small')).not.toThrow();
  });

  test('default auth: ORCAROUTER_API_KEY set -> Bearer token', () => {
    const r = getRecipe('orcarouter')!;
    const auth = defaultResolveAuth(r, { ORCAROUTER_API_KEY: 'fake-orcarouter-key' }, 'embedding');
    expect(auth.headerName).toBe('Authorization');
    expect(auth.token).toBe('Bearer fake-orcarouter-key');
  });

  test('default auth: missing ORCAROUTER_API_KEY -> AIConfigError', () => {
    const r = getRecipe('orcarouter')!;
    expect(() => defaultResolveAuth(r, {}, 'embedding')).toThrow(AIConfigError);
  });

  test('no attribution headers are sent (unlike OpenRouter)', () => {
    // The gateway defines no HTTP-Referer / X-Title convention; sending
    // OpenRouter's would be meaningless noise on the wire.
    expect(getRecipe('orcarouter')!.resolveDefaultHeaders).toBeUndefined();
  });
});
