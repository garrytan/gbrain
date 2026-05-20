/**
 * Qwen3-Embedding dimension passthrough on the openai-compatible adapter.
 *
 * Qwen3-Embedding (commonly served via Ollama / llama.cpp) is a Matryoshka
 * model with a large native dim — 4096 for the 8B. Without forwarding
 * `dimensions`, the endpoint returns the full native vector and the embed
 * fails the dim-consistency check against a narrower schema width.
 *
 * Pins:
 *  - dimsProviderOptions forwards `dimensions` for qwen3-embedding* model ids
 *  - the Ollama tag-suffixed id form (`qwen3-embedding:8b-q4_K_M`) is matched
 *  - a non-default width is honored verbatim
 *  - no input_type leaks (symmetric model)
 */

import { describe, test, expect } from 'bun:test';
import { dimsProviderOptions } from '../../src/core/ai/dims.ts';

describe('dimsProviderOptions — Qwen3-Embedding branch', () => {
  test('forwards dimensions for a bare qwen3-embedding id', () => {
    const opts = dimsProviderOptions('openai-compatible', 'qwen3-embedding-8b', 1024);
    expect(opts).toEqual({ openaiCompatible: { dimensions: 1024 } });
  });

  test('matches the Ollama tag-suffixed id form', () => {
    // A configured `ollama:qwen3-embedding:8b-q4_K_M` has its provider
    // stripped, leaving modelId `qwen3-embedding:8b-q4_K_M`.
    const opts = dimsProviderOptions('openai-compatible', 'qwen3-embedding:8b-q4_K_M', 1024);
    expect(opts).toEqual({ openaiCompatible: { dimensions: 1024 } });
  });

  test('honors a non-default width (4B native 2560)', () => {
    const opts = dimsProviderOptions('openai-compatible', 'qwen3-embedding:4b', 2560);
    expect(opts).toEqual({ openaiCompatible: { dimensions: 2560 } });
  });

  test('does not leak input_type (symmetric model)', () => {
    const opts = dimsProviderOptions('openai-compatible', 'qwen3-embedding-8b', 1024, 'query');
    expect(opts).toEqual({ openaiCompatible: { dimensions: 1024 } });
    expect(JSON.stringify(opts)).not.toContain('input_type');
  });
});
