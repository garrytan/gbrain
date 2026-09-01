/**
 * Google recipe — gemini-embedding-2 catalog entry.
 *
 * `models` is informational since v0.44.1.0 (assertTouchpoint no longer
 * enforces model membership), so the load-bearing assertion is the catalog
 * one: the GA model must be listed so `gbrain providers list` and the docs
 * advertise it. The last test pins that dimsProviderOptions() keeps
 * forwarding outputDimensionality for the new id exactly as for
 * gemini-embedding-001 (dims.ts prefix-matches `gemini-embedding`).
 */

import { describe, expect, test } from 'bun:test';
import { getRecipe } from '../../src/core/ai/recipes/index.ts';
import { assertTouchpoint, resolveRecipe } from '../../src/core/ai/model-resolver.ts';
import { dimsProviderOptions } from '../../src/core/ai/dims.ts';

describe('google recipe — gemini-embedding-2', () => {
  test('is listed in the embedding catalog', () => {
    expect(getRecipe('google')?.touchpoints.embedding?.models).toContain('gemini-embedding-2');
  });

  test('resolves on the embedding touchpoint', () => {
    const { parsed, recipe } = resolveRecipe('google:gemini-embedding-2');
    expect(() => assertTouchpoint(recipe, 'embedding', parsed.modelId)).not.toThrow();
  });

  test('forwards outputDimensionality like gemini-embedding-001', () => {
    expect(dimsProviderOptions('native-google', 'gemini-embedding-2', 1536))
      .toEqual({ google: { outputDimensionality: 1536 } });
  });
});
