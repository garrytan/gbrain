/**
 * OpenRouter recipe smoke.
 */

import { describe, expect, test } from 'bun:test';
import { getRecipe } from '../../src/core/ai/recipes/index.ts';
import { defaultResolveAuth } from '../../src/core/ai/gateway.ts';
import { assertTouchpoint } from '../../src/core/ai/model-resolver.ts';
import { AIConfigError } from '../../src/core/ai/errors.ts';

describe('recipe: openrouter', () => {
  test('registered with expected shape', () => {
    const r = getRecipe('openrouter');
    expect(r).toBeDefined();
    expect(r!.id).toBe('openrouter');
    expect(r!.tier).toBe('openai-compat');
    expect(r!.implementation).toBe('openai-compatible');
    expect(r!.base_url_default).toBe('https://openrouter.ai/api/v1');
    expect(r!.auth_env?.required).toEqual(['OPENROUTER_API_KEY']);
    expect(r!.auth_env?.optional).toContain('OPENROUTER_BASE_URL');
  });

  test('embedding touchpoint defaults to OpenAI small embeddings at 1536 dims', () => {
    const r = getRecipe('openrouter')!;
    expect(r.touchpoints.embedding).toBeDefined();
    expect(r.touchpoints.embedding!.models[0]).toBe('openai/text-embedding-3-small');
    expect(r.touchpoints.embedding!.default_dims).toBe(1536);
    expect(r.touchpoints.embedding!.max_batch_tokens).toBeGreaterThan(0);
  });

  test('chat touchpoint accepts arbitrary OpenRouter model ids', () => {
    const r = getRecipe('openrouter')!;
    expect(r.touchpoints.chat).toBeDefined();
    expect(r.touchpoints.chat!.supports_tools).toBe(true);
    expect(r.touchpoints.chat!.supports_subagent_loop).toBe(false);
    expect(() => assertTouchpoint(r, 'chat', 'some/provider-model')).not.toThrow();
  });

  test('default auth: OPENROUTER_API_KEY set -> "Bearer <key>"', () => {
    const r = getRecipe('openrouter')!;
    const auth = defaultResolveAuth(
      r,
      { OPENROUTER_API_KEY: 'sk-or-fake' },
      'embedding',
    );
    expect(auth.headerName).toBe('Authorization');
    expect(auth.token).toBe('Bearer sk-or-fake');
  });

  test('default auth: missing OPENROUTER_API_KEY -> AIConfigError', () => {
    const r = getRecipe('openrouter')!;
    expect(() => defaultResolveAuth(r, {}, 'embedding')).toThrow(AIConfigError);
  });
});
