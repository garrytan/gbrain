import { describe, expect, test } from 'bun:test';
import { buildEmbeddingRequest, resolveEmbeddingConfig } from '../src/core/embedding.ts';

describe('resolveEmbeddingConfig', () => {
  test('uses local fallback api key when custom base URL is configured', () => {
    const resolved = resolveEmbeddingConfig({
      engine: 'pglite',
      embedding_base_url: 'http://127.0.0.1:8100/v1',
      embedding_model: 'gte-Qwen2-1.5B-instruct',
      embedding_dimensions: 1536,
    });

    expect(resolved.baseUrl).toBe('http://127.0.0.1:8100/v1');
    expect(resolved.apiKey).toBe('local-embedding');
    expect(resolved.model).toBe('gte-Qwen2-1.5B-instruct');
    expect(resolved.dimensions).toBe(1536);
    expect(resolved.isCustomBaseUrl).toBe(true);
  });

  test('prefers explicit embedding api key when provided', () => {
    const resolved = resolveEmbeddingConfig({
      engine: 'pglite',
      embedding_base_url: 'http://127.0.0.1:8100/v1',
      embedding_api_key: 'secret-key',
    });

    expect(resolved.apiKey).toBe('secret-key');
  });
});

describe('buildEmbeddingRequest', () => {
  test('omits dimensions for custom local base URLs', () => {
    const config = resolveEmbeddingConfig({
      engine: 'pglite',
      embedding_base_url: 'http://127.0.0.1:8100/v1',
      embedding_model: 'gte-Qwen2-1.5B-instruct',
      embedding_dimensions: 1536,
    });

    expect(buildEmbeddingRequest(['hello'], config)).toEqual({
      model: 'gte-Qwen2-1.5B-instruct',
      input: ['hello'],
    });
  });

  test('keeps dimensions for default OpenAI embedding requests', () => {
    const config = resolveEmbeddingConfig({
      engine: 'pglite',
      openai_api_key: 'sk-test',
    });

    expect(buildEmbeddingRequest(['hello'], config)).toEqual({
      model: 'text-embedding-3-large',
      input: ['hello'],
      dimensions: 1536,
    });
  });
});
