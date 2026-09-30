/**
 * The `nous` recipe: Nous Research Portal, an OpenRouter-shaped
 * OpenAI-compatible gateway (`inference-api.nousresearch.com/v1`) authenticated
 * with a Portal inference API key. Pins registration, the family-scoped
 * predicates, the embedding-dims table, and the `nous_api_key` config → env
 * fold that lets daemon/launchd/MCP processes receive the key.
 */
import { describe, test, expect } from 'bun:test';
import { getRecipe } from '../src/core/ai/recipes/index.ts';
import { nousSupportsPromptCache, nousThinkingByDefault } from '../src/core/ai/recipes/nous.ts';
import { embeddingDimsForModel, resolveRecipe } from '../src/core/ai/model-resolver.ts';
import { mergedProviderEnv } from '../src/core/ai/provider-env.ts';
import { KNOWN_CONFIG_KEYS, type GBrainConfig } from '../src/core/config.ts';
import { FILE_PLANE_API_KEYS } from '../src/commands/config.ts';
import { DB_MERGED_PROVIDER_KEY_FIELDS } from '../src/core/config-db-merge.ts';

describe('nous recipe registration', () => {
  test('getRecipe returns an openai-compatible Recipe at the Portal inference URL', () => {
    const recipe = getRecipe('nous');
    expect(recipe).toBeDefined();
    expect(recipe!.id).toBe('nous');
    expect(recipe!.tier).toBe('openai-compat');
    expect(recipe!.implementation).toBe('openai-compatible');
    expect(recipe!.base_url_default).toBe('https://inference-api.nousresearch.com/v1');
    expect(recipe!.auth_env?.required).toEqual(['NOUS_API_KEY']);
  });

  test('declares chat + expansion + embedding; chat routes may drive the subagent loop', () => {
    const recipe = getRecipe('nous')!;
    expect(recipe.touchpoints.chat!.supports_tools).toBe(true);
    expect(recipe.touchpoints.chat!.supports_subagent_loop).toBe(true);
    expect(recipe.touchpoints.chat!.models[0]).toBe('z-ai/glm-5.3-flash');
    expect(recipe.touchpoints.expansion!.models).toContain('z-ai/glm-5.3-flash');
    expect(recipe.touchpoints.embedding!.models).toContain('openai/text-embedding-3-small');
    // Aliases keep tier configs short and portable with openrouter/zhipu spellings.
    expect(recipe.aliases!['glm-flash']).toBe('z-ai/glm-5.3-flash');
    expect(recipe.aliases!['luna']).toBe('openai/gpt-5.6-luna');
    expect(recipe.aliases!['sonnet']).toBe('anthropic/claude-sonnet-5');
  });

  test('model strings resolve through the recipe with the org slash intact', () => {
    const { recipe, parsed } = resolveRecipe('nous:z-ai/glm-5.3-flash');
    expect(recipe.id).toBe('nous');
    expect(parsed.modelId).toBe('z-ai/glm-5.3-flash');
    // Aliases resolve to canonical slash-form ids.
    expect(resolveRecipe('nous:glm-flash').parsed.modelId).toBe('z-ai/glm-5.3-flash');
  });
});

describe('nous family-scoped predicates', () => {
  test('thinking_by_default: DeepSeek and GLM-4.5+/5.x routes, nothing else', () => {
    expect(nousThinkingByDefault('deepseek/deepseek-v4-flash')).toBe(true);
    expect(nousThinkingByDefault('z-ai/glm-5.3-flash')).toBe(true);
    expect(nousThinkingByDefault('z-ai/glm-4.5')).toBe(true);
    expect(nousThinkingByDefault('z-ai/glm-4')).toBe(false);
    expect(nousThinkingByDefault('openai/gpt-5.6-luna')).toBe(false);
    expect(nousThinkingByDefault('anthropic/claude-sonnet-5')).toBe(false);
    const recipe = getRecipe('nous')!;
    expect(typeof recipe.touchpoints.chat!.thinking_by_default).toBe('function');
  });

  test('supports_prompt_cache: OpenAI per generation, DeepSeek always, Anthropic false (no cache_control shim here)', () => {
    expect(nousSupportsPromptCache('deepseek/deepseek-v4-pro')).toBe(true);
    expect(nousSupportsPromptCache('anthropic/claude-sonnet-5')).toBe(false);
    expect(nousSupportsPromptCache('z-ai/glm-5.3-flash')).toBe(false);
    // Delegates to the openai recipe's generation table for openai/ routes.
    expect(typeof nousSupportsPromptCache('openai/gpt-5.5')).toBe('boolean');
    expect(nousSupportsPromptCache('openai/gpt-5.5:batch')).toBe(nousSupportsPromptCache('openai/gpt-5.5'));
  });
});

describe('nous embedding dims', () => {
  test('listed models resolve to their vendor widths; unlisted ids fail closed to 0', () => {
    const recipe = getRecipe('nous')!;
    expect(embeddingDimsForModel(recipe, 'openai/text-embedding-3-small')).toBe(1536);
    expect(embeddingDimsForModel(recipe, 'openai/text-embedding-3-large')).toBe(3072);
    expect(embeddingDimsForModel(recipe, 'voyageai/voyage-4')).toBe(1024);
    expect(embeddingDimsForModel(recipe, 'qwen/qwen3-embedding-8b')).toBe(0);
  });
});

describe('nous_api_key config → env fold', () => {
  const cfg = (partial: Partial<GBrainConfig>): GBrainConfig => ({ engine: 'pglite', ...partial }) as GBrainConfig;
  test('config.json nous_api_key reaches the gateway env as NOUS_API_KEY; env wins over config', () => {
    expect(mergedProviderEnv(cfg({ nous_api_key: 'sk-nous-file' }), {}).NOUS_API_KEY).toBe('sk-nous-file');
    expect(mergedProviderEnv(cfg({ nous_api_key: 'sk-nous-file' }), { NOUS_API_KEY: 'sk-nous-env' }).NOUS_API_KEY).toBe('sk-nous-env');
    expect(mergedProviderEnv(cfg({}), {}).NOUS_API_KEY).toBeUndefined();
  });
  test('the key is wired through every sibling list (config set acceptance, redaction, DB merge)', () => {
    expect(KNOWN_CONFIG_KEYS).toContain('nous_api_key');
    expect(FILE_PLANE_API_KEYS).toContain('nous_api_key');
    expect(DB_MERGED_PROVIDER_KEY_FIELDS as readonly string[]).toContain('nous_api_key');
  });
});
