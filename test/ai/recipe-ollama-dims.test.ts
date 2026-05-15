/**
 * Ollama Matryoshka dims passthrough.
 *
 * Several embedding models served via Ollama (Qwen3-Embedding family) support
 * Matryoshka truncation through the `dimensions` field on /v1/embeddings.
 * Without this passthrough, gbrain ignores user-selected reduced dims and the
 * provider returns its native size, causing dim-mismatch failures against
 * brains configured for smaller widths.
 */

import { describe, expect, test } from 'bun:test';
import { dimsProviderOptions } from '../../src/core/ai/dims.ts';

describe('dims: ollama Matryoshka models', () => {
  test('qwen3-embedding:4b threads dimensions=1536', () => {
    expect(dimsProviderOptions('openai-compatible', 'qwen3-embedding:4b', 1536))
      .toEqual({ openaiCompatible: { dimensions: 1536 } });
  });

  test('qwen3-embedding:0.6b threads dimensions=512', () => {
    expect(dimsProviderOptions('openai-compatible', 'qwen3-embedding:0.6b', 512))
      .toEqual({ openaiCompatible: { dimensions: 512 } });
  });

  test('qwen3-embedding:8b threads dimensions=2048', () => {
    expect(dimsProviderOptions('openai-compatible', 'qwen3-embedding:8b', 2048))
      .toEqual({ openaiCompatible: { dimensions: 2048 } });
  });

  test('bare qwen3-embedding (no quant tag) also recognized', () => {
    expect(dimsProviderOptions('openai-compatible', 'qwen3-embedding', 1024))
      .toEqual({ openaiCompatible: { dimensions: 1024 } });
  });

  test('unrelated openai-compat model returns undefined (regression guard)', () => {
    expect(dimsProviderOptions('openai-compatible', 'nomic-embed-text', 768))
      .toBeUndefined();
    expect(dimsProviderOptions('openai-compatible', 'mxbai-embed-large', 1024))
      .toBeUndefined();
  });
});
