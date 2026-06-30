/**
 * Ollama (local) recipe shape + local-provider dim policy.
 *
 * Pins the PR2 contract (#2170 / #2271 / #2051): the curated embedding model
 * list, the nomic-anchored shorthand default, and the `isLocalUserProvidedDims`
 * predicate that lets ollama / llama-server / litellm carry an explicit custom
 * dim through the init preflight. The per-model native dims themselves are
 * exercised in test/embedding-dim-check.test.ts (the resolver that consumes
 * dims.ts:OLLAMA_NATIVE_DIMS).
 */

import { describe, test, expect } from 'bun:test';
import { ollama } from '../../src/core/ai/recipes/ollama.ts';
import { RECIPES, getRecipe } from '../../src/core/ai/recipes/index.ts';
import { isLocalUserProvidedDims, ollamaNativeDim } from '../../src/core/ai/dims.ts';

describe('ollama recipe shape', () => {
  test('registered in ALL[] via index.ts', () => {
    expect(RECIPES.has('ollama')).toBe(true);
    expect(getRecipe('ollama')).toBe(ollama);
  });

  test('embedding touchpoint lists the curated models incl. the 1024-dim ones', () => {
    const e = ollama.touchpoints.embedding!;
    // nomic stays first so the `--model ollama` shorthand picks it (768).
    expect(e.models[0]).toBe('nomic-embed-text');
    for (const m of [
      'nomic-embed-text',
      'mxbai-embed-large',
      'all-minilm',
      'bge-m3',
      'snowflake-arctic-embed2',
    ]) {
      expect(e.models, `expected ${m} in ollama model list`).toContain(m);
    }
    expect(e.default_dims).toBe(768); // shorthand fallback (nomic native)
    expect(e.no_batch_cap).toBe(true);
    expect(e.user_provided_models).toBeUndefined(); // ollama HAS a curated list
  });

  test('curated models have known native dims (drive column sizing + validation)', () => {
    expect(ollamaNativeDim('nomic-embed-text')).toBe(768);
    expect(ollamaNativeDim('mxbai-embed-large')).toBe(1024);
    expect(ollamaNativeDim('all-minilm')).toBe(384);
    expect(ollamaNativeDim('bge-m3')).toBe(1024);
    expect(ollamaNativeDim('snowflake-arctic-embed2')).toBe(1024);
    // Every listed model must have a native-dim entry, or init can't size it.
    for (const m of ollama.touchpoints.embedding!.models) {
      expect(ollamaNativeDim(m), `${m} missing from OLLAMA_NATIVE_DIMS`).toBeDefined();
    }
    expect(ollamaNativeDim('some-unlisted-model')).toBeUndefined();
  });

  test('auth_env stays empty-required (local, unauthenticated)', () => {
    expect(ollama.auth_env!.required).toEqual([]);
    expect(ollama.auth_env!.optional).toContain('OLLAMA_BASE_URL');
  });
});

describe('isLocalUserProvidedDims', () => {
  test('true for ollama (by id) and llama-server / litellm (user_provided_models)', () => {
    expect(isLocalUserProvidedDims(getRecipe('ollama')!)).toBe(true);
    expect(isLocalUserProvidedDims(getRecipe('llama-server')!)).toBe(true);
    expect(isLocalUserProvidedDims(getRecipe('litellm')!)).toBe(true);
  });

  test('false for hosted providers (openai / voyage / zeroentropyai)', () => {
    expect(isLocalUserProvidedDims(getRecipe('openai')!)).toBe(false);
    expect(isLocalUserProvidedDims(getRecipe('voyage')!)).toBe(false);
    expect(isLocalUserProvidedDims(getRecipe('zeroentropyai')!)).toBe(false);
  });
});
