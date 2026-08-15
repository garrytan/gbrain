/**
 * Moonshot/Kimi local recipe smoke.
 *
 * This pins the governed production exception GBrain-Local-003: GBrain can
 * route configured Kimi chat/expansion IDs through Moonshot's OpenAI-compatible
 * endpoint without treating `moonshot` as an unknown provider.
 */

import { describe, expect, test } from 'bun:test';
import { getRecipe } from '../../src/core/ai/recipes/index.ts';
import { defaultResolveAuth } from '../../src/core/ai/gateway.ts';
import { assertTouchpoint } from '../../src/core/ai/model-resolver.ts';
import { AIConfigError } from '../../src/core/ai/errors.ts';

describe('recipe: moonshot', () => {
  test('registered with expected OpenAI-compatible shape', () => {
    const r = getRecipe('moonshot');
    expect(r).toBeDefined();
    expect(r!.id).toBe('moonshot');
    expect(r!.tier).toBe('openai-compat');
    expect(r!.implementation).toBe('openai-compatible');
    expect(r!.base_url_default).toBe('https://api.moonshot.ai/v1');
    expect(r!.auth_env?.required).toEqual(['MOONSHOT_API_KEY']);
  });

  test('chat and expansion touchpoints include Kimi K2.7 Code', () => {
    const r = getRecipe('moonshot')!;
    expect(r.touchpoints.chat).toBeDefined();
    expect(r.touchpoints.expansion).toBeDefined();
    expect(r.touchpoints.chat!.models).toContain('kimi-k2.7-code');
    expect(r.touchpoints.expansion!.models).toContain('kimi-k2.7-code');
    expect(r.touchpoints.chat!.supports_tools).toBe(true);
    expect(r.touchpoints.chat!.supports_subagent_loop).toBe(false);
  });

  test('configured Kimi model is accepted for chat and expansion', () => {
    const r = getRecipe('moonshot')!;
    expect(() => assertTouchpoint(r, 'chat', 'kimi-k2.7-code')).not.toThrow();
    expect(() => assertTouchpoint(r, 'expansion', 'kimi-k2.7-code')).not.toThrow();
  });

  test('default auth: MOONSHOT_API_KEY set -> Bearer token', () => {
    const r = getRecipe('moonshot')!;
    const auth = defaultResolveAuth(r, { MOONSHOT_API_KEY: 'fake-moonshot-key' }, 'chat');
    expect(auth.headerName).toBe('Authorization');
    expect(auth.token).toBe('Bearer fake-moonshot-key');
  });

  test('default auth: missing MOONSHOT_API_KEY -> AIConfigError', () => {
    const r = getRecipe('moonshot')!;
    expect(() => defaultResolveAuth(r, {}, 'chat')).toThrow(AIConfigError);
  });
});
