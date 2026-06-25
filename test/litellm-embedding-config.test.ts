import { afterEach, describe, expect, test } from 'bun:test';

import { configureGateway, diagnoseEmbedding, resetGateway } from '../src/core/ai/gateway.ts';
import { resolveSchemaEmbeddingDim } from '../src/core/embedding-dim-check.ts';

afterEach(() => {
  resetGateway();
});

describe('OpenAI-compatible embedding configuration', () => {
  test('diagnoseEmbedding accepts explicit LiteLLM model ids', () => {
    configureGateway({
      embedding_model: 'litellm:text-embedding-qwen3-embedding-0.6b',
      embedding_dimensions: 1024,
      env: { LITELLM_API_KEY: 'test-key' },
      base_urls: { litellm: 'http://127.0.0.1:1234/v1' },
    });

    expect(diagnoseEmbedding()).toEqual({
      ok: true,
      model: 'litellm:text-embedding-qwen3-embedding-0.6b',
      provider: 'litellm',
      recipeId: 'litellm',
    });
  });

  test('diagnoseEmbedding still rejects provider-only LiteLLM embedding config', () => {
    configureGateway({
      embedding_model: 'litellm',
      embedding_dimensions: 1024,
      env: { LITELLM_API_KEY: 'test-key' },
      base_urls: { litellm: 'http://127.0.0.1:1234/v1' },
    });

    expect(diagnoseEmbedding()).toMatchObject({
      ok: false,
      reason: 'unknown_provider',
      provider: 'unknown',
    });
  });

  test('schema dim resolver treats user-provided OpenAI-compatible dims as native schema sizing', () => {
    expect(resolveSchemaEmbeddingDim({
      embedding_model: 'litellm:text-embedding-qwen3-embedding-0.6b',
      embedding_dimensions: 1024,
    })).toMatchObject({ ok: true, dim: 1024, provider: 'litellm' });

    expect(resolveSchemaEmbeddingDim({
      embedding_model: 'llama-server:nomic-embed-text',
      embedding_dimensions: 768,
    })).toMatchObject({ ok: true, dim: 768, provider: 'llama-server' });
  });
});
