import { describe, expect, test } from 'bun:test';
import { getRecipe } from '../../src/core/ai/recipes/index.ts';
import { assertTouchpoint, resolveRecipe } from '../../src/core/ai/model-resolver.ts';
import { AIConfigError } from '../../src/core/ai/errors.ts';

describe('model resolver: openai-codex strict allowlist', () => {
  test('accepts the registered Codex model', () => {
    const { recipe, parsed } = resolveRecipe('openai-codex:gpt-5.5');
    expect(recipe.id).toBe('openai-codex');
    expect(parsed.modelId).toBe('gpt-5.5');
    expect(() => assertTouchpoint(recipe, 'chat', parsed.modelId)).not.toThrow();
  });

  test('rejects unlisted Codex models', () => {
    const r = getRecipe('openai-codex')!;
    expect(() => assertTouchpoint(r, 'chat', 'not-gpt-5.5')).toThrow(AIConfigError);
  });

  test('strict Codex allowlist is not bypassed by config-extended models', () => {
    const r = getRecipe('openai-codex')!;
    const extended = new Set(['not-gpt-5.5']);
    expect(() => assertTouchpoint(r, 'chat', 'not-gpt-5.5', extended)).toThrow(AIConfigError);
  });

  test('openai-compatible providers still tolerate arbitrary chat model IDs', () => {
    const r = getRecipe('openrouter')!;
    expect(r.tier).toBe('openai-compat');
    expect(() => assertTouchpoint(r, 'chat', 'some/provider-model')).not.toThrow();
  });
});
