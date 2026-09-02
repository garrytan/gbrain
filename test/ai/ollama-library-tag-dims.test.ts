/**
 * Ollama library-tag dims — coverage for the pullable-tag catalog refresh.
 *
 * `qwen3-embedding:8b` is the first colon-bearing model tag in any recipe's
 * models list, which makes it the first tag to exercise
 * `embeddingDimsForModel()`'s strip-the-leading-`provider:`-prefix logic with
 * a colon INSIDE the model id. Both the qualified form
 * (`ollama:qwen3-embedding:8b`) and the bare form (`qwen3-embedding:8b`)
 * resolve to the declared 4096 — the lookup tries the id exactly as given
 * before assuming a leading `provider:` separator (#3904).
 */

import { describe, expect, test } from 'bun:test';
import { getRecipe } from '../../src/core/ai/recipes/index.ts';
import { embeddingDimsForModel, resolveRecipe } from '../../src/core/ai/model-resolver.ts';
import { resolveMigrationTarget } from '../../src/core/embedding-migration.ts';

describe('ollama library-tag dims — new pullable tags', () => {
  const ollama = getRecipe('ollama')!;

  test('snowflake-arctic-embed2 resolves to 1024 (bare and qualified)', () => {
    expect(embeddingDimsForModel(ollama, 'snowflake-arctic-embed2')).toBe(1024);
    expect(embeddingDimsForModel(ollama, 'ollama:snowflake-arctic-embed2')).toBe(1024);
  });

  test('qualified ollama:qwen3-embedding:8b resolves to 4096 (colon tag survives the provider strip)', () => {
    expect(embeddingDimsForModel(ollama, 'ollama:qwen3-embedding:8b')).toBe(4096);
  });

  test('bare qwen3-embedding:8b resolves to its true 4096', () => {
    // embeddingDimsForModel() now tries the id exactly as given (an exact
    // model_dims lookup) before assuming a leading `provider:` separator,
    // so the bare colon-bearing form resolves correctly instead of silently
    // falling back to default_dims (768).
    expect(embeddingDimsForModel(ollama, 'qwen3-embedding:8b')).toBe(4096);
  });

  test('resolver output preserves the colon-bearing tag for dimension lookup', () => {
    const { parsed, recipe } = resolveRecipe('ollama:qwen3-embedding:8b');
    expect(parsed.modelId).toBe('qwen3-embedding:8b');
    expect(embeddingDimsForModel(recipe, parsed.modelId)).toBe(4096);
  });

  test('legacy spellings keep validating at their declared dims', () => {
    expect(embeddingDimsForModel(ollama, 'qwen3-embed-8b')).toBe(4096);
    expect(embeddingDimsForModel(ollama, 'snowflake-arctic-embed-l-v2')).toBe(1024);
  });

  test('both new tags are listed in the embedding touchpoint models', () => {
    const models = getRecipe('ollama')!.touchpoints.embedding!.models;
    expect(models).toContain('qwen3-embedding:8b');
    expect(models).toContain('snowflake-arctic-embed2');
  });

  test('SWEEP: every listed model with a declared dim resolves through the qualified form', () => {
    // Future colon-bearing tags stay safe: the qualified form (what init and
    // migration actually pass) must always reach the declared model_dims row.
    const tp = ollama.touchpoints.embedding!;
    for (const [model, dims] of Object.entries(tp.model_dims ?? {})) {
      expect(
        embeddingDimsForModel(ollama, `ollama:${model}`),
        `ollama:${model} must resolve to its declared ${dims}`,
      ).toBe(dims);
    }
  });
});

describe('embedding-migrate --to accepts the new tags at their native widths', () => {
  test('resolveMigrationTarget(ollama:qwen3-embedding:8b) → 4096', () => {
    expect(resolveMigrationTarget('ollama:qwen3-embedding:8b')).toEqual({
      toModel: 'ollama:qwen3-embedding:8b',
      toDims: 4096,
    });
  });

  test('resolveMigrationTarget(ollama:snowflake-arctic-embed2) → 1024', () => {
    expect(resolveMigrationTarget('ollama:snowflake-arctic-embed2')).toEqual({
      toModel: 'ollama:snowflake-arctic-embed2',
      toDims: 1024,
    });
  });

  test('bare colon tag fails loud, not silently at 768 [PIN]', () => {
    // 'qwen3-embedding:8b' PASSES the includes(':') qualification guard (it
    // contains a colon), so the fail-loud contract this file's header relies
    // on actually comes from resolveRecipe throwing on the unknown provider
    // 'qwen3-embedding'. Pin that: if recipe resolution ever became lenient,
    // a bare colon tag would silently plan a 768-wide migration.
    expect(() => resolveMigrationTarget('qwen3-embedding:8b')).toThrow();
  });
});
