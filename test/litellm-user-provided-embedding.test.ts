import { afterEach, describe, expect, test } from 'bun:test';

import { configureGateway, diagnoseEmbedding, resetGateway } from '../src/core/ai/gateway.ts';
import { resolveSchemaEmbeddingDim } from '../src/core/embedding-dim-check.ts';

afterEach(() => {
  resetGateway();
});

describe('user-provided OpenAI-compatible embedding models', () => {
  test('LiteLLM explicit model dimensions are treated as native schema sizing', () => {
    const got = resolveSchemaEmbeddingDim({
      embedding_model: 'litellm:local.embed.qwen3-4b.1536.mlx',
      embedding_dimensions: 1536,
    });

    expect(got).toEqual({
      ok: true,
      dim: 1536,
      model: 'litellm:local.embed.qwen3-4b.1536.mlx',
      provider: 'litellm',
      recipeDefault: 0,
    });
  });

  test('llama-server explicit model dimensions are treated as native schema sizing', () => {
    const got = resolveSchemaEmbeddingDim({
      embedding_model: 'llama-server:bge-small-en-v1.5',
      embedding_dimensions: 384,
    });

    expect(got).toMatchObject({
      ok: true,
      dim: 384,
      provider: 'llama-server',
      recipeDefault: 0,
    });
  });

  test('LiteLLM embedding diagnosis accepts the configured explicit model', () => {
    configureGateway({
      embedding_model: 'litellm:local.embed.qwen3-4b.1536.mlx',
      embedding_dimensions: 1536,
      base_urls: { litellm: 'http://127.0.0.1:4000/v1' },
      env: {},
    });

    expect(diagnoseEmbedding()).toEqual({
      ok: true,
      model: 'litellm:local.embed.qwen3-4b.1536.mlx',
      provider: 'litellm',
      recipeId: 'litellm',
    });
  });

  test('LiteLLM embedding diagnosis rejects unconfigured user-provided model overrides', () => {
    configureGateway({
      embedding_model: 'litellm:local.embed.qwen3-4b.1536.mlx',
      embedding_dimensions: 1536,
      base_urls: { litellm: 'http://127.0.0.1:4000/v1' },
      env: {},
    });

    expect(diagnoseEmbedding('litellm:local.embed.qwen3-vl.1536.mlx')).toEqual({
      ok: false,
      reason: 'user_provided_model_unset',
      model: 'litellm:local.embed.qwen3-vl.1536.mlx',
      provider: 'litellm',
      recipeId: 'litellm',
    });
  });

  test('llama-server embedding diagnosis accepts the configured explicit model', () => {
    configureGateway({
      embedding_model: 'llama-server:bge-small-en-v1.5',
      embedding_dimensions: 384,
      base_urls: { 'llama-server': 'http://127.0.0.1:8080/v1' },
      env: {},
    });

    expect(diagnoseEmbedding()).toEqual({
      ok: true,
      model: 'llama-server:bge-small-en-v1.5',
      provider: 'llama-server',
      recipeId: 'llama-server',
    });
  });
});
