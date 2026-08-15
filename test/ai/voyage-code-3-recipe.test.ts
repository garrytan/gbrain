/**
 * v0.37.3 — voyage-code-3 registration regression pin.
 *
 * voyage-code-3 is the user-facing recommendation for gstack per-worktree
 * code brains (Topology 3 in docs/architecture/topologies.md). The model
 * was already registered before v0.37.3 but never surfaced as the right
 * default for code indexing. These assertions guard against a future
 * Voyage recipe refactor silently dropping voyage-code-3 from either the
 * allowlist or the flexible-dim set.
 *
 * Also pins voyage-code-3 on the SDK-supported `dimensions` field path
 * via dimsProviderOptions() — that's the v0.33.1.0 wire-key bug class.
 */

import { describe, expect, test } from 'bun:test';
import { getRecipe } from '../../src/core/ai/recipes/index.ts';
import {
  supportsVoyageOutputDimension,
  isValidVoyageOutputDim,
  dimsProviderOptions,
  VOYAGE_VALID_OUTPUT_DIMS,
} from '../../src/core/ai/dims.ts';

describe('recipe: voyage — voyage-code-3 registration', () => {
  test('voyage-code-3 is in the embedding touchpoint models list', () => {
    const r = getRecipe('voyage');
    expect(r).toBeDefined();
    expect(r!.touchpoints.embedding).toBeDefined();
    expect(r!.touchpoints.embedding!.models).toContain('voyage-code-3');
  });

  test('voyage-code-3 supports flexible output dimensions', () => {
    expect(supportsVoyageOutputDimension('voyage-code-3')).toBe(true);
  });

  test('all four canonical Voyage dims are accepted', () => {
    // The set is locked at 256/512/1024/2048 — flexible-dim Voyage models
    // (incl. voyage-code-3) accept exactly this set. Pinning each one
    // catches the v0.33.1.0-class regression where a Voyage flexible-dim
    // model accidentally falls back to default 1024 because dim validation
    // drifts.
    for (const dims of [256, 512, 1024, 2048]) {
      expect(isValidVoyageOutputDim(dims)).toBe(true);
    }
    expect([...VOYAGE_VALID_OUTPUT_DIMS]).toEqual([256, 512, 1024, 2048]);
  });

  test('dimsProviderOptions returns SDK-shape dimensions field (not output_dimension wire-key)', () => {
    // The v0.33.1.0 bug class: sending Voyage's `output_dimension` wire-key
    // through the AI SDK gets silently dropped (SDK doesn't recognize it),
    // Voyage falls back to default 1024, and any brain configured for
    // 2048 silently embeds at the wrong width. The fix in v0.33.1.1 routes
    // through the SDK-supported `dimensions` field; the voyageCompatFetch
    // shim then translates to output_dimension on the wire.
    const opts = dimsProviderOptions('openai-compatible', 'voyage-code-3', 1024);
    expect(opts).toBeDefined();
    // Shape: { openaiCompatible: { dimensions: 1024 } }
    expect(opts).toHaveProperty('openaiCompatible.dimensions', 1024);
    // Negative regression: no output_dimension on the providerOptions surface
    const raw = JSON.stringify(opts);
    expect(raw).not.toContain('output_dimension');
  });
});
