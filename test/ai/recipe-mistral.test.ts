/**
 * Mistral recipe smoke.
 *
 * The load-bearing assertion here is the negative one: mistral-embed rejects
 * every dimension parameter with HTTP 400, so dimsProviderOptions() must emit
 * no dimension field for it. Same contract as voyage-4-nano, pinned the same
 * way (see the negative regression assertion in test/ai/gateway.test.ts).
 */

import { describe, expect, test } from 'bun:test';
import { getRecipe } from '../../src/core/ai/recipes/index.ts';
import { defaultResolveAuth } from '../../src/core/ai/gateway.ts';
import { assertTouchpoint } from '../../src/core/ai/model-resolver.ts';
import { AIConfigError } from '../../src/core/ai/errors.ts';
import { dimsProviderOptions } from '../../src/core/ai/dims.ts';
import { lookupEmbeddingPrice } from '../../src/core/embedding-pricing.ts';

describe('recipe: mistral', () => {
  test('registered with expected OpenAI-compatible shape', () => {
    const r = getRecipe('mistral');
    expect(r).toBeDefined();
    expect(r!.id).toBe('mistral');
    expect(r!.tier).toBe('openai-compat');
    expect(r!.implementation).toBe('openai-compatible');
    expect(r!.base_url_default).toBe('https://api.mistral.ai/v1');
    expect(r!.auth_env?.required).toEqual(['MISTRAL_API_KEY']);
  });

  test('embedding touchpoint pins the measured 1024 dims and 64K batch ceiling', () => {
    const e = getRecipe('mistral')!.touchpoints.embedding;
    expect(e).toBeDefined();
    expect(e!.models).toContain('mistral-embed');
    expect(e!.default_dims).toBe(1024);
    // Measured: a 65,286-token batch is accepted, 66,960 returns 400 code 3210.
    expect(e!.max_batch_tokens).toBe(65_536);
    // chars_per_token is a DIVISOR in splitByTokenBudget(), so a lower value
    // is the conservative direction. The module default of 4 is an English
    // assumption and overshoots on denser prose.
    expect(e!.chars_per_token).toBe(2);
  });

  test('NEGATIVE: no dimension parameter is emitted for mistral-embed', () => {
    // Mistral rejects both spellings:
    //   {"dimensions": N}       -> 400 extra_forbidden
    //   {"output_dimension": N} -> 400 "does not support output_dimension"
    // If a future change adds mistral-embed to a flexible-dim allowlist in
    // dims.ts, this assertion fails before it reaches users as a 400 on every
    // embed call.
    expect(dimsProviderOptions('openai-compatible', 'mistral-embed', 1024)).toBeUndefined();
    expect(dimsProviderOptions('openai-compatible', 'mistral-embed-2312', 1024)).toBeUndefined();
  });

  test('embedding models resolve to a known price', () => {
    // An unknown price makes the embedding spend cap fail closed.
    expect(lookupEmbeddingPrice('mistral:mistral-embed').kind).toBe('known');
    expect(lookupEmbeddingPrice('mistral:mistral-embed-2312').kind).toBe('known');
  });

  test('chat and expansion touchpoints accept their configured models', () => {
    const r = getRecipe('mistral')!;
    expect(r.touchpoints.chat!.supports_tools).toBe(true);
    expect(r.touchpoints.chat!.supports_subagent_loop).toBe(false);
    expect(() => assertTouchpoint(r, 'chat', 'mistral-small-latest')).not.toThrow();
    expect(() => assertTouchpoint(r, 'expansion', 'ministral-3b-latest')).not.toThrow();
    expect(() => assertTouchpoint(r, 'embedding', 'mistral-embed')).not.toThrow();
  });

  test('codestral-embed is deliberately absent (1536 dims would mix under a 1024 declaration)', () => {
    const e = getRecipe('mistral')!.touchpoints.embedding!;
    expect(e.models).not.toContain('codestral-embed');
    expect(e.models).not.toContain('codestral-embed-2505');
  });

  test('default auth: MISTRAL_API_KEY set -> Bearer token', () => {
    const r = getRecipe('mistral')!;
    const auth = defaultResolveAuth(r, { MISTRAL_API_KEY: 'fake-mistral-key' }, 'embedding');
    expect(auth.headerName).toBe('Authorization');
    expect(auth.token).toBe('Bearer fake-mistral-key');
  });

  test('default auth: missing MISTRAL_API_KEY -> AIConfigError', () => {
    const r = getRecipe('mistral')!;
    expect(() => defaultResolveAuth(r, {}, 'embedding')).toThrow(AIConfigError);
  });
});
