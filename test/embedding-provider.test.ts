import { afterEach, describe, expect, test } from 'bun:test';
import { resolveEmbeddingProvider } from '../src/core/embedding-provider.ts';

const ORIGINAL_ENV = {
  GBRAIN_EMBEDDING_PROVIDER: process.env.GBRAIN_EMBEDDING_PROVIDER,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  VENICE_API_KEY: process.env.VENICE_API_KEY,
  VENICE_BASE_URL: process.env.VENICE_BASE_URL,
};

afterEach(() => {
  restoreEnv();
});

describe('resolveEmbeddingProvider', () => {
  test('prefers OpenAI when OPENAI_API_KEY is set', () => {
    process.env.OPENAI_API_KEY = 'sk-openai';

    const provider = resolveEmbeddingProvider();

    expect(provider?.provider).toBe('openai');
    expect(provider?.model).toBe('text-embedding-3-large');
    expect(provider?.dimensions).toBe(1536);
  });

  test('supports native Venice configuration', () => {
    process.env.GBRAIN_EMBEDDING_PROVIDER = 'venice';
    process.env.VENICE_API_KEY = 'venice-key';

    const provider = resolveEmbeddingProvider();

    expect(provider?.provider).toBe('venice');
    expect(provider?.baseURL).toBe('https://api.venice.ai/api/v1');
    expect(provider?.model).toBe('text-embedding-bge-m3');
    expect(provider?.dimensions).toBe(1536);
  });

  test('supports Venice via OpenAI-compatible env vars', () => {
    process.env.OPENAI_API_KEY = 'venice-via-openai-key';
    process.env.OPENAI_BASE_URL = 'https://api.venice.ai/api/v1';

    const provider = resolveEmbeddingProvider();

    expect(provider?.provider).toBe('venice');
    expect(provider?.apiKey).toBe('venice-via-openai-key');
    expect(provider?.baseURL).toBe('https://api.venice.ai/api/v1');
  });

  test('uses default Venice base URL when provider is venice and key comes from OPENAI_API_KEY', () => {
    process.env.GBRAIN_EMBEDDING_PROVIDER = 'venice';
    process.env.OPENAI_API_KEY = 'shared-compatible-key';

    const provider = resolveEmbeddingProvider();

    expect(provider?.provider).toBe('venice');
    expect(provider?.apiKey).toBe('shared-compatible-key');
    expect(provider?.baseURL).toBe('https://api.venice.ai/api/v1');
  });
});

function restoreEnv() {
  setEnv('GBRAIN_EMBEDDING_PROVIDER', ORIGINAL_ENV.GBRAIN_EMBEDDING_PROVIDER);
  setEnv('OPENAI_API_KEY', ORIGINAL_ENV.OPENAI_API_KEY);
  setEnv('OPENAI_BASE_URL', ORIGINAL_ENV.OPENAI_BASE_URL);
  setEnv('VENICE_API_KEY', ORIGINAL_ENV.VENICE_API_KEY);
  setEnv('VENICE_BASE_URL', ORIGINAL_ENV.VENICE_BASE_URL);
}

function setEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
