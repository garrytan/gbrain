import { describe, test, expect, afterEach } from 'bun:test';
import { resolveEmbeddingConfig } from '../src/core/embedding.ts';

const ENV_KEYS = [
  'GBRAIN_EMBEDDING_MODEL',
  'GBRAIN_EMBEDDING_DIMENSIONS',
  'GBRAIN_EMBEDDING_BASE_URL',
  'GBRAIN_EMBEDDING_API_KEY',
  'OPENAI_API_KEY',
  'PERPLEXITY_API_KEY',
  'PPLX_API_KEY',
];

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

describe('embedding configuration', () => {
  test('defaults to OpenAI text-embedding-3-large at 1536 dimensions', () => {
    const config = resolveEmbeddingConfig({});

    expect(config.model).toBe('text-embedding-3-large');
    expect(config.dimensions).toBe(1536);
    expect(config.baseURL).toBeUndefined();
    expect(config.apiKey).toBeUndefined();
    expect(config.provider).toBe('openai-compatible');
  });

  test('reads OpenAI-compatible model, dimensions, base URL, and key from env', () => {
    const config = resolveEmbeddingConfig({
      GBRAIN_EMBEDDING_MODEL: 'custom-embed-model',
      GBRAIN_EMBEDDING_DIMENSIONS: '768',
      GBRAIN_EMBEDDING_BASE_URL: 'http://127.0.0.1:8790/v1',
      GBRAIN_EMBEDDING_API_KEY: 'local-key',
      OPENAI_API_KEY: 'wrong-key',
    });

    expect(config.model).toBe('custom-embed-model');
    expect(config.dimensions).toBe(768);
    expect(config.baseURL).toBe('http://127.0.0.1:8790/v1');
    expect(config.apiKey).toBe('local-key');
  });

  test('falls back to OPENAI_API_KEY when no embedding-specific key is set', () => {
    const config = resolveEmbeddingConfig({ OPENAI_API_KEY: 'openai-key' });

    expect(config.apiKey).toBe('openai-key');
  });

  test('uses migrated Perplexity keys for explicit Perplexity embedding configs', () => {
    const config = resolveEmbeddingConfig({
      GBRAIN_EMBEDDING_MODEL: 'pplx-embed-context-v1-4b',
      GBRAIN_EMBEDDING_BASE_URL: 'http://127.0.0.1:8790/v1',
      PERPLEXITY_API_KEY: 'pplx-key',
      OPENAI_API_KEY: 'wrong-openai-key',
    });

    expect(config.apiKey).toBe('pplx-key');
    expect(config.provider).toBe('openai-compatible');
  });

  test('does not leak OPENAI_API_KEY into explicit Perplexity configs', () => {
    const config = resolveEmbeddingConfig({
      GBRAIN_EMBEDDING_MODEL: 'pplx-embed-v1-4b',
      GBRAIN_EMBEDDING_BASE_URL: 'https://api.perplexity.ai/v1',
      OPENAI_API_KEY: 'wrong-openai-key',
    });

    expect(config.apiKey).toBeUndefined();
    expect(config.provider).toBe('perplexity-hosted');
  });

  test('detects hosted Perplexity endpoint with migrated key', () => {
    const config = resolveEmbeddingConfig({
      GBRAIN_EMBEDDING_MODEL: 'pplx-embed-v1-4b',
      GBRAIN_EMBEDDING_DIMENSIONS: '2560',
      GBRAIN_EMBEDDING_BASE_URL: 'https://api.perplexity.ai/v1',
      PERPLEXITY_API_KEY: 'pplx-key',
    });

    expect(config.model).toBe('pplx-embed-v1-4b');
    expect(config.dimensions).toBe(2560);
    expect(config.apiKey).toBe('pplx-key');
    expect(config.provider).toBe('perplexity-hosted');
  });

  test('uses a harmless placeholder key for local OpenAI-compatible base URLs', () => {
    const config = resolveEmbeddingConfig({
      GBRAIN_EMBEDDING_BASE_URL: 'http://127.0.0.1:8790/v1',
    });

    expect(config.apiKey).toBe('not-needed');
  });

  test('rejects non-positive embedding dimensions', () => {
    expect(() => resolveEmbeddingConfig({ GBRAIN_EMBEDDING_DIMENSIONS: '0' })).toThrow(
      'GBRAIN_EMBEDDING_DIMENSIONS must be a positive integer',
    );
  });
});
