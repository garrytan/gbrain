/**
 * Cheaper Inference recipe smoke.
 *
 * Chat + expansion only: the gateway has no /embeddings surface, so the
 * recipe must not declare an embedding touchpoint.
 */

import { describe, expect, test } from 'bun:test';
import { getRecipe } from '../../src/core/ai/recipes/index.ts';
import { defaultResolveAuth } from '../../src/core/ai/gateway.ts';
import { assertTouchpoint } from '../../src/core/ai/model-resolver.ts';
import { AIConfigError } from '../../src/core/ai/errors.ts';

describe('recipe: cheaperinference', () => {
  test('registered with expected OpenAI-compatible shape', () => {
    const r = getRecipe('cheaperinference');
    expect(r).toBeDefined();
    expect(r!.id).toBe('cheaperinference');
    expect(r!.tier).toBe('openai-compat');
    expect(r!.implementation).toBe('openai-compatible');
    expect(r!.base_url_default).toBe('https://api.cheaperinference.com/v1');
    expect(r!.auth_env?.required).toEqual(['CHEAPER_INFERENCE_API_KEY']);
  });

  test('chat and expansion touchpoints, no embedding touchpoint', () => {
    const r = getRecipe('cheaperinference')!;
    expect(r.touchpoints.embedding).toBeUndefined();
    expect(r.touchpoints.chat!.models).toContain('gpt-5.4-mini');
    expect(r.touchpoints.expansion!.models).toContain('gpt-5.4-mini');
    expect(r.touchpoints.chat!.supports_tools).toBe(true);
    expect(r.touchpoints.chat!.supports_subagent_loop).toBe(false);
  });

  test('configured models are accepted for chat and expansion', () => {
    const r = getRecipe('cheaperinference')!;
    expect(() => assertTouchpoint(r, 'chat', 'gpt-5.4-mini')).not.toThrow();
    expect(() => assertTouchpoint(r, 'chat', 'claude-sonnet-5')).not.toThrow();
    expect(() => assertTouchpoint(r, 'expansion', 'gpt-5.4-mini')).not.toThrow();
  });

  test('default auth: CHEAPER_INFERENCE_API_KEY set -> Bearer token', () => {
    const r = getRecipe('cheaperinference')!;
    const auth = defaultResolveAuth(r, { CHEAPER_INFERENCE_API_KEY: 'fake-ci-key' }, 'chat');
    expect(auth.headerName).toBe('Authorization');
    expect(auth.token).toBe('Bearer fake-ci-key');
  });

  test('default auth: missing CHEAPER_INFERENCE_API_KEY -> AIConfigError', () => {
    const r = getRecipe('cheaperinference')!;
    expect(() => defaultResolveAuth(r, {}, 'chat')).toThrow(AIConfigError);
  });
});
