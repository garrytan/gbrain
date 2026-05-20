/**
 * Kimi / Moonshot AI recipe smoke.
 *
 * Coverage:
 *  - Recipe registered with expected OpenAI-compatible shape
 *  - Chat + expansion touchpoints expose current Kimi model IDs
 *  - default auth: MOONSHOT_API_KEY -> Authorization Bearer
 */

import { describe, expect, test } from 'bun:test';
import { getRecipe } from '../../src/core/ai/recipes/index.ts';
import { defaultResolveAuth } from '../../src/core/ai/gateway.ts';
import { AIConfigError } from '../../src/core/ai/errors.ts';

describe('recipe: kimi', () => {
  test('registered with expected provider shape', () => {
    const r = getRecipe('kimi');
    expect(r).toBeDefined();
    expect(r!.id).toBe('kimi');
    expect(r!.name).toBe('Kimi (Moonshot AI)');
    expect(r!.tier).toBe('openai-compat');
    expect(r!.implementation).toBe('openai-compatible');
    expect(r!.base_url_default).toBe('https://api.moonshot.ai/v1');
    expect(r!.auth_env?.required).toEqual(['MOONSHOT_API_KEY']);
  });

  test('expansion touchpoint declares Kimi models', () => {
    const r = getRecipe('kimi')!;
    expect(r.touchpoints.expansion).toBeDefined();
    expect(r.touchpoints.expansion!.models[0]).toBe('kimi-k2.6');
    expect(r.touchpoints.expansion!.models).toContain('kimi-k2.5');
    expect(r.touchpoints.expansion!.models).toContain('kimi-k2-turbo-preview');
    expect(r.touchpoints.expansion!.models).toContain('kimi-k2-thinking');
  });

  test('chat touchpoint declares Kimi models and conservative capabilities', () => {
    const r = getRecipe('kimi')!;
    expect(r.touchpoints.chat).toBeDefined();
    expect(r.touchpoints.chat!.models[0]).toBe('kimi-k2.6');
    expect(r.touchpoints.chat!.models).toContain('kimi-k2.5');
    expect(r.touchpoints.chat!.supports_tools).toBe(true);
    expect(r.touchpoints.chat!.supports_subagent_loop).toBe(false);
    expect(r.touchpoints.chat!.supports_prompt_cache).toBe(false);
    expect(r.touchpoints.chat!.max_context_tokens).toBe(256000);
  });

  test('default auth: MOONSHOT_API_KEY set -> Bearer token', () => {
    const r = getRecipe('kimi')!;
    const auth = defaultResolveAuth(r, { MOONSHOT_API_KEY: 'fake-moonshot-key' }, 'chat');
    expect(auth.headerName).toBe('Authorization');
    expect(auth.token).toBe('Bearer fake-moonshot-key');
  });

  test('default auth: missing MOONSHOT_API_KEY -> AIConfigError', () => {
    const r = getRecipe('kimi')!;
    expect(() => defaultResolveAuth(r, {}, 'chat')).toThrow(AIConfigError);
  });
});
