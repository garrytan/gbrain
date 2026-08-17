/**
 * #2051 — per-model embedding dimensions for local recipes.
 *
 * Ollama serves models spanning 384..4096 dims, but the recipe declared a
 * single `default_dims: 768` (nomic-embed-text's width). Every other model
 * resolved to 768, so `gbrain init --embedding-model ollama:bge-m3` created a
 * 768-wide column for a model emitting 1024 and the mismatch only surfaced at
 * first insert.
 *
 * `embeddingDimsForModel()` consults the recipe's `model_dims` map first and
 * falls back to `default_dims`, so:
 *   1. Known models resolve to their true native width.
 *   2. Unlisted models still fall back (no regression for arbitrary pulls).
 *   3. `user_provided_models` recipes keep returning 0, which is what forces
 *      an explicit `--embedding-dimensions`.
 */

import { test, expect, describe } from 'bun:test';
import { getRecipe } from '../src/core/ai/recipes/index.ts';
import { embeddingDimsForModel } from '../src/core/ai/model-resolver.ts';

describe('embeddingDimsForModel — per-model dims (#2051)', () => {
  const ollama = getRecipe('ollama')!;

  test('bge-m3 resolves to its native 1024, not the recipe default 768', () => {
    expect(embeddingDimsForModel(ollama, 'bge-m3')).toBe(1024);
  });

  test('accepts a provider-qualified id', () => {
    expect(embeddingDimsForModel(ollama, 'ollama:bge-m3')).toBe(1024);
  });

  test.each([
    ['nomic-embed-text', 768],
    ['mxbai-embed-large', 1024],
    ['all-minilm', 384],
    ['qwen3-embed-8b', 4096],
    ['snowflake-arctic-embed-l-v2', 1024],
  ])('%s resolves to %i', (model, dims) => {
    expect(embeddingDimsForModel(ollama, model as string)).toBe(dims as number);
  });

  test('every declared model_dims entry is also a listed model', () => {
    const listed = new Set(ollama.touchpoints.embedding!.models);
    for (const model of Object.keys(ollama.touchpoints.embedding!.model_dims ?? {})) {
      expect(listed.has(model)).toBe(true);
    }
  });

  test('an unlisted model falls back to the recipe default', () => {
    expect(embeddingDimsForModel(ollama, 'some-model-pulled-locally')).toBe(768);
  });

  test('a missing model id falls back to the recipe default', () => {
    expect(embeddingDimsForModel(ollama, undefined)).toBe(768);
  });

  test('llama-server still returns 0 so explicit dimensions stay required', () => {
    const llamaServer = getRecipe('llama-server')!;
    expect(embeddingDimsForModel(llamaServer, 'anything')).toBe(0);
  });

  test('fixed-dim hosted recipes are unaffected', () => {
    const openai = getRecipe('openai')!;
    const tp = openai.touchpoints.embedding!;
    expect(embeddingDimsForModel(openai, tp.models[0])).toBe(tp.default_dims);
  });
});

describe('case-folded model_dims lookup (#4123 init-time twin)', () => {
  const ollama = getRecipe('ollama')!;

  test('cased configured id resolves against the lowercase table instead of falling to default_dims', () => {
    expect(embeddingDimsForModel(ollama, 'ollama:Qwen3-Embed-8B')).toBe(4096);
    expect(embeddingDimsForModel(ollama, 'Qwen3-Embed-8B')).toBe(4096);
  });

  test('cased table keys resolve too (user-editable recipes carry cased keys — both sides fold)', () => {
    const recipe = {
      ...ollama,
      touchpoints: {
        ...ollama.touchpoints,
        embedding: {
          ...ollama.touchpoints.embedding!,
          model_dims: { 'Custom-Embed-XL': 2048 },
        },
      },
    };
    expect(embeddingDimsForModel(recipe, 'custom-embed-xl')).toBe(2048);
    expect(embeddingDimsForModel(recipe, 'Custom-Embed-XL')).toBe(2048);
  });
});
