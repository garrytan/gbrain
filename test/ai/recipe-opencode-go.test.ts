/**
 * Smoke test for the opencode-go recipe.
 *
 * Verifies:
 *  - Recipe is registered and discoverable
 *  - Auth env contract (resolveAuth returns Bearer token when key is set)
 *  - Chat touchpoint present with expected properties
 *  - Provider capability classification returns correct verdict
 */

import { describe, expect, test } from 'bun:test';
import { getRecipe } from '../../src/core/ai/recipes/index.ts';
import { defaultResolveAuth } from '../../src/core/ai/gateway.ts';
import { classifyCapabilities } from '../../src/core/ai/capabilities.ts';
import { withEnv } from '../helpers/with-env.ts';

describe('opencode-go recipe', () => {
  const RECIPE_ID = 'opencode-go';

  test('recipe is registered in the index', () => {
    const recipe = getRecipe(RECIPE_ID);
    expect(recipe).toBeDefined();
    expect(recipe!.id).toBe(RECIPE_ID);
    expect(recipe!.tier).toBe('openai-compat');
    expect(recipe!.implementation).toBe('openai-compatible');
  });

  test('base URL points to opencode.ai zen endpoint', () => {
    const recipe = getRecipe(RECIPE_ID)!;
    expect(recipe.base_url_default).toBe('https://opencode.ai/zen/go/v1');
  });

  test('auth_env requires OPENCODE_GO_API_KEY', () => {
    const recipe = getRecipe(RECIPE_ID)!;
    expect(recipe.auth_env?.required).toContain('OPENCODE_GO_API_KEY');
  });

  test('resolveAuth returns Bearer token when OPENCODE_GO_API_KEY is set', async () => {
    const recipe = getRecipe(RECIPE_ID)!;
    await withEnv({ OPENCODE_GO_API_KEY: 'sk-test-fake-key' }, async () => {
      const auth = defaultResolveAuth(recipe, process.env, 'chat');
      expect(auth.headerName).toBe('Authorization');
      expect(auth.token).toBe('Bearer sk-test-fake-key');
    });
  });

  test('resolveAuth throws when OPENCODE_GO_API_KEY is missing', async () => {
    const recipe = getRecipe(RECIPE_ID)!;
    await withEnv({ OPENCODE_GO_API_KEY: '' }, async () => {
      expect(() => defaultResolveAuth(recipe, process.env, 'chat')).toThrow();
    });
  });

  test('chat touchpoint has expected properties', () => {
    const recipe = getRecipe(RECIPE_ID)!;
    const chat = recipe.touchpoints.chat;
    expect(chat).toBeDefined();
    expect(chat!.supports_tools).toBe(true);
    expect(chat!.supports_subagent_loop).toBe(true);
    expect(chat!.supports_prompt_cache).toBe(false);
    expect(chat!.models).toContain('deepseek-v4-flash');
    expect(chat!.models).toContain('deepseek-v4-pro');
    expect(chat!.models).toContain('qwen3.5-plus');
  });

  test('classifyCapabilities returns degraded:no_caching for opencode-go models', () => {
    const verdict = classifyCapabilities('opencode-go:deepseek-v4-flash');
    // OpenAI-compat: supports tools but not prompt caching
    expect(verdict).toBe('degraded:no_caching');
  });
});
