import { describe, expect, test } from 'bun:test';
import { envReady, formatRecipeTable } from '../../src/commands/providers.ts';
import { AIConfigError } from '../../src/core/ai/errors.ts';
import { defaultResolveAuth } from '../../src/core/ai/gateway.ts';
import { assertTouchpoint, resolveRecipe } from '../../src/core/ai/model-resolver.ts';
import { atlascloud } from '../../src/core/ai/recipes/atlascloud.ts';
import { getRecipe, RECIPES } from '../../src/core/ai/recipes/index.ts';
import { deepseekReasoningContentCompatFetch } from '../../src/core/ai/recipes/deepseek.ts';

describe('recipe: atlascloud', () => {
  test('registered with the OpenAI-compatible Atlas Cloud endpoint', () => {
    expect(RECIPES.has('atlascloud')).toBe(true);
    expect(getRecipe('atlascloud')).toBe(atlascloud);
    expect(atlascloud.tier).toBe('openai-compat');
    expect(atlascloud.implementation).toBe('openai-compatible');
    expect(atlascloud.base_url_default).toBe('https://api.atlascloud.ai/v1');
  });

  test('uses an isolated ATLASCLOUD_API_KEY bearer token', () => {
    expect(atlascloud.resolveAuth).toBeUndefined();
    expect(atlascloud.auth_env?.required).toEqual(['ATLASCLOUD_API_KEY']);
    expect(
      defaultResolveAuth(
        atlascloud,
        { ATLASCLOUD_API_KEY: 'fake-atlascloud-key' },
        'chat',
      ),
    ).toEqual({
      headerName: 'Authorization',
      token: 'Bearer fake-atlascloud-key',
    });
    expect(() =>
      defaultResolveAuth(atlascloud, { OPENAI_API_KEY: 'sk-test' }, 'chat'),
    ).toThrow(AIConfigError);
  });

  test('declares the catalog-backed chat and expansion model', () => {
    const model = 'deepseek-ai/deepseek-v4-pro';
    expect(atlascloud.touchpoints.expansion?.models).toEqual([model]);
    expect(atlascloud.touchpoints.chat?.models).toEqual([model]);
    expect(atlascloud.touchpoints.chat).toMatchObject({
      supports_tools: true,
      supports_subagent_loop: false,
      supports_prompt_cache: false,
      supports_structured_outputs: true,
      max_context_tokens: 1_048_576,
    });
    expect(atlascloud.compat?.fetch).toBe(deepseekReasoningContentCompatFetch);
  });

  test('resolves nested model ids for chat and expansion', () => {
    const qualified = 'atlascloud:deepseek-ai/deepseek-v4-pro';
    const { parsed, recipe } = resolveRecipe(qualified);
    expect(recipe).toBe(atlascloud);
    expect(parsed).toEqual({
      providerId: 'atlascloud',
      modelId: 'deepseek-ai/deepseek-v4-pro',
    });
    expect(() => assertTouchpoint(recipe, 'chat', parsed.modelId)).not.toThrow();
    expect(() => assertTouchpoint(recipe, 'expansion', parsed.modelId)).not.toThrow();
  });

  test('appears in the provider table with accurate env readiness', () => {
    expect(envReady(atlascloud, {})).toBe(false);
    expect(envReady(atlascloud, { ATLASCLOUD_API_KEY: 'fake-atlascloud-key' })).toBe(true);

    const missing = formatRecipeTable([atlascloud], {});
    expect(missing).toContain('atlascloud');
    expect(missing).toContain('missing ATLASCLOUD_API_KEY');

    const ready = formatRecipeTable(
      [atlascloud],
      { ATLASCLOUD_API_KEY: 'fake-atlascloud-key' },
    );
    expect(ready).toContain('ready');
  });
});
