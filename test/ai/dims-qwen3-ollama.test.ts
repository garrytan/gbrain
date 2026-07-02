/**
 * Qwen3-Embedding Matryoshka (MRL) support on local openai-compat providers.
 *
 * Pins:
 *  - The ollama recipe declares `dims_options` so `gbrain init
 *    --embedding-model ollama:qwen3-embedding:* --embedding-dimensions N`
 *    passes the preflight resolver for MRL steps (Tier 1 of
 *    isCustomDimValidForProvider). Previously every non-default dim was
 *    rejected as "does not support custom dimensions", making the only
 *    Matryoshka-capable paths cloud providers — a dead end for
 *    local-only/data-sovereignty setups.
 *  - dimsProviderOptions emits `{ openaiCompatible: { dimensions } }` for
 *    qwen3-embedding* model ids so the truncation request actually reaches
 *    the server. Ollama honors the OpenAI `dimensions` param for MRL models
 *    (verified against Ollama 0.31.1 /v1/embeddings: qwen3-embedding:8b
 *    with dimensions=1536 returns 1536-wide vectors). Without this, the
 *    gateway silently omits the param and the server returns the native
 *    4096 — exploding at first write against a vector(1536) column.
 *  - Qwen3 embeddings are symmetric: no `input_type` is emitted (some
 *    openai-compat servers reject unknown fields).
 *  - Non-Matryoshka ollama models (nomic-embed-text etc.) keep returning
 *    undefined from dimsProviderOptions — no behavior change.
 */

import { describe, test, expect } from 'bun:test';
import { dimsProviderOptions } from '../../src/core/ai/dims.ts';
import { resolveSchemaEmbeddingDim } from '../../src/core/embedding-dim-check.ts';
import { getRecipe } from '../../src/core/ai/recipes/index.ts';

describe('dimsProviderOptions — qwen3-embedding on openai-compatible', () => {
  test('emits dimensions for qwen3-embedding tags (quant suffixes included)', () => {
    for (const modelId of [
      'qwen3-embedding:8b',
      'qwen3-embedding:8b-fp16',
      'qwen3-embedding:4b',
      'qwen3-embedding:0.6b',
    ]) {
      expect(dimsProviderOptions('openai-compatible', modelId, 1536)).toEqual({
        openaiCompatible: { dimensions: 1536 },
      });
    }
  });

  test('symmetric model: no input_type emitted even when inputType is threaded', () => {
    const opts = dimsProviderOptions('openai-compatible', 'qwen3-embedding:8b', 1024, 'query');
    expect(opts).toEqual({ openaiCompatible: { dimensions: 1024 } });
  });

  test('non-Matryoshka ollama models keep the no-param behavior', () => {
    expect(dimsProviderOptions('openai-compatible', 'nomic-embed-text', 768)).toBeUndefined();
    expect(dimsProviderOptions('openai-compatible', 'mxbai-embed-large', 1024)).toBeUndefined();
  });
});

describe('ollama recipe — dims_options preflight (init-time)', () => {
  test('recipe declares Matryoshka steps including the pgvector-HNSW-safe 1536', () => {
    const recipe = getRecipe('ollama');
    expect(recipe).toBeDefined();
    const dimsOptions = recipe!.touchpoints.embedding?.dims_options ?? [];
    expect(dimsOptions).toContain(1536);
    expect(dimsOptions).toContain(4096); // qwen3 native width
  });

  test('resolveSchemaEmbeddingDim accepts ollama:qwen3-embedding at MRL steps', () => {
    for (const model of ['ollama:qwen3-embedding:8b', 'ollama:qwen3-embedding:8b-fp16']) {
      const result = resolveSchemaEmbeddingDim({
        embedding_model: model,
        embedding_dimensions: 1536,
      });
      expect(result.ok, `expected ok for ${model}: ${result.ok ? '' : result.error}`).toBe(true);
      if (result.ok) {
        expect(result.dim).toBe(1536);
        expect(result.provider).toBe('ollama');
      }
    }
  });

  test('rejects dims outside dims_options with the allowed list', () => {
    const result = resolveSchemaEmbeddingDim({
      embedding_model: 'ollama:qwen3-embedding:8b',
      embedding_dimensions: 1000,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('1536');
    }
  });

  test('regression: recipe default stays 768 (nomic-embed-text)', () => {
    const result = resolveSchemaEmbeddingDim({
      embedding_model: 'ollama:nomic-embed-text',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.dim).toBe(768);
  });
});
