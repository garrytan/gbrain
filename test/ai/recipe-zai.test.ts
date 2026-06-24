/**
 * Z.AI chat recipe smoke.
 *
 * Coverage:
 *  - Recipe registered with expected OpenAI-compatible shape
 *  - GLM-5.2 chat touchpoint advertises 1M context and tool support
 *  - default auth: ZAI_API_KEY -> "Bearer <key>"; missing -> AIConfigError
 */

import { describe, expect, test } from 'bun:test';
import { getRecipe } from '../../src/core/ai/recipes/index.ts';
import { defaultResolveAuth } from '../../src/core/ai/gateway.ts';
import { AIConfigError } from '../../src/core/ai/errors.ts';

describe('recipe: zai', () => {
  test('registered with expected shape', () => {
    const r = getRecipe('zai');
    expect(r).toBeDefined();
    expect(r!.id).toBe('zai');
    expect(r!.tier).toBe('openai-compat');
    expect(r!.implementation).toBe('openai-compatible');
    expect(r!.base_url_default).toBe('https://api.z.ai/api/paas/v4');
    expect(r!.auth_env?.required).toEqual(['ZAI_API_KEY']);
  });

  test('chat touchpoint exposes GLM-5.2 for Sonnet-class routing', () => {
    const r = getRecipe('zai')!;
    expect(r.touchpoints.chat).toBeDefined();
    expect(r.touchpoints.chat!.models).toContain('glm-5.2');
    expect(r.touchpoints.chat!.supports_tools).toBe(true);
    expect(r.touchpoints.chat!.supports_subagent_loop).toBe(true);
    expect(r.touchpoints.chat!.supports_prompt_cache).toBe(false);
    expect(r.touchpoints.chat!.max_context_tokens).toBe(1_000_000);
    expect(r.touchpoints.chat!.cost_per_1m_input_usd).toBe(1.4);
    expect(r.touchpoints.chat!.cost_per_1m_output_usd).toBe(4.4);
  });

  test('default auth: ZAI_API_KEY set -> "Bearer <key>"', () => {
    const r = getRecipe('zai')!;
    const auth = defaultResolveAuth(r, { ZAI_API_KEY: 'fake-zai-key' }, 'chat');
    expect(auth.headerName).toBe('Authorization');
    expect(auth.token).toBe('Bearer fake-zai-key');
  });

  test('default auth: missing ZAI_API_KEY -> AIConfigError', () => {
    const r = getRecipe('zai')!;
    expect(() => defaultResolveAuth(r, {}, 'chat')).toThrow(AIConfigError);
  });
});
