/**
 * trust_custom_dims passthrough tests.
 *
 * Pins the fix for: recipes that declare `trust_custom_dims: true`
 * (ollama, llama-server) had that flag relax schema-width validation in
 * embedding-dim-check.ts, but dimsProviderOptions never consulted it — a
 * generic openai-compatible model outside the explicit ZE/Voyage/text-3/
 * DashScope/Zhipu/MiniMax allowlist always fell through to `undefined`,
 * so the gateway silently requested the model's native (untruncated)
 * output even when the brain was configured for a smaller width. The
 * mismatch only surfaced at first embed or in `gbrain doctor`'s live
 * probe, as an opaque "dim mismatch" error.
 *
 * Verified against a live Ollama instance during development: Ollama's
 * `/v1/embeddings` accepts an OpenAI-shaped `dimensions` field and
 * returns a genuinely truncated vector for qwen3-embedding:8b (confirmed
 * 4096 → 2000 via curl). This test suite pins the plumbing, not the live
 * network call.
 */

import { describe, test, expect } from 'bun:test';
import { dimsProviderOptions } from '../../src/core/ai/dims.ts';

describe('dimsProviderOptions — trustCustomDims fallback', () => {
  test('ollama-style model with trustCustomDims=true emits dimensions', () => {
    const opts = dimsProviderOptions('openai-compatible', 'qwen3-embedding:8b', 2000, undefined, true);
    expect(opts).toEqual({ openaiCompatible: { dimensions: 2000 } });
  });

  test('llama-server-style model with trustCustomDims=true emits dimensions', () => {
    const opts = dimsProviderOptions('openai-compatible', 'my-local-gguf', 1024, undefined, true);
    expect(opts).toEqual({ openaiCompatible: { dimensions: 1024 } });
  });

  test('unknown model WITHOUT trustCustomDims returns undefined (no behavior change)', () => {
    const opts = dimsProviderOptions('openai-compatible', 'qwen3-embedding:8b', 2000);
    expect(opts).toBeUndefined();
  });

  test('trustCustomDims=false is treated the same as omitted', () => {
    const opts = dimsProviderOptions('openai-compatible', 'qwen3-embedding:8b', 2000, undefined, false);
    expect(opts).toBeUndefined();
  });

  test('trustCustomDims does not override the explicit allowlist branches (ZE)', () => {
    // zembed-1 hits its own branch first regardless of trustCustomDims,
    // and still enforces its own dim allowlist.
    const opts = dimsProviderOptions('openai-compatible', 'zembed-1', 1280, undefined, true);
    expect(opts).toEqual({ openaiCompatible: { dimensions: 1280, input_type: 'document' } });
  });

  test('trustCustomDims fallback ignores inputType (symmetric assumption)', () => {
    const opts = dimsProviderOptions('openai-compatible', 'qwen3-embedding:8b', 2000, 'query', true);
    expect(opts).toEqual({ openaiCompatible: { dimensions: 2000 } });
    expect(JSON.stringify(opts)).not.toContain('input_type');
  });

  test('native-openai implementation is unaffected by trustCustomDims', () => {
    // trustCustomDims is only consulted in the openai-compatible branch;
    // native-openai keeps its existing text-embedding-3-* gate.
    const opts = dimsProviderOptions('native-openai', 'some-other-model', 1000, undefined, true);
    expect(opts).toBeUndefined();
  });
});
