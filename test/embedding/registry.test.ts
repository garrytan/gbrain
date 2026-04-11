import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { getProvider, resetProvider, loadEmbeddingConfig } from '../../src/core/embedding/registry.ts';

describe('getProvider', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    resetProvider();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    resetProvider();
  });

  test('defaults to OpenAI text-embedding-3-large', () => {
    delete process.env.GBRAIN_EMBEDDING_PROVIDER;
    delete process.env.GBRAIN_EMBEDDING_MODEL;
    const provider = getProvider();
    expect(provider.name).toBe('openai');
    expect(provider.model).toBe('text-embedding-3-large');
    expect(provider.dimensions).toBe(1536);
  });

  test('respects GBRAIN_EMBEDDING_PROVIDER env var', () => {
    process.env.GBRAIN_EMBEDDING_PROVIDER = 'gemini';
    const provider = getProvider();
    expect(provider.name).toBe('gemini');
    expect(provider.model).toBe('gemini-embedding-2-preview');
  });

  test('respects GBRAIN_EMBEDDING_PROVIDER env var for voyage', () => {
    process.env.GBRAIN_EMBEDDING_PROVIDER = 'voyage';
    const provider = getProvider();
    expect(provider.name).toBe('voyage');
    expect(provider.model).toBe('voyage-4-large');
  });

  test('respects GBRAIN_EMBEDDING_MODEL env var', () => {
    process.env.GBRAIN_EMBEDDING_PROVIDER = 'openai';
    process.env.GBRAIN_EMBEDDING_MODEL = 'text-embedding-3-small';
    process.env.GBRAIN_EMBEDDING_DIMENSIONS = '512';
    const provider = getProvider();
    expect(provider.name).toBe('openai');
    expect(provider.model).toBe('text-embedding-3-small');
    expect(provider.dimensions).toBe(512);
  });

  test('caches provider instance', () => {
    const a = getProvider();
    const b = getProvider();
    expect(a).toBe(b);
  });

  test('throws on unknown provider', () => {
    process.env.GBRAIN_EMBEDDING_PROVIDER = 'unknown';
    expect(() => getProvider()).toThrow('Unknown embedding provider: unknown');
  });

  test('throws on NaN dimensions', () => {
    process.env.GBRAIN_EMBEDDING_DIMENSIONS = 'notanumber';
    expect(() => getProvider()).toThrow('Invalid GBRAIN_EMBEDDING_DIMENSIONS');
  });

  test('throws on negative dimensions', () => {
    process.env.GBRAIN_EMBEDDING_DIMENSIONS = '-100';
    expect(() => getProvider()).toThrow('Invalid GBRAIN_EMBEDDING_DIMENSIONS');
  });

  test('throws on zero dimensions', () => {
    process.env.GBRAIN_EMBEDDING_DIMENSIONS = '0';
    expect(() => getProvider()).toThrow('Invalid GBRAIN_EMBEDDING_DIMENSIONS');
  });

  test('trims whitespace from model name', () => {
    process.env.GBRAIN_EMBEDDING_MODEL = '  text-embedding-3-large  ';
    const provider = getProvider();
    expect(provider.model).toBe('text-embedding-3-large');
  });

  test('throws on empty model name', () => {
    process.env.GBRAIN_EMBEDDING_MODEL = '   ';
    expect(() => getProvider()).toThrow('GBRAIN_EMBEDDING_MODEL cannot be empty');
  });
});

describe('loadEmbeddingConfig + DB config fallback', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    resetProvider();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    resetProvider();
  });

  function mockEngine(config: Record<string, string>) {
    return { getConfig: async (key: string) => config[key] || null };
  }

  test('falls back to DB config when env vars not set', async () => {
    delete process.env.GBRAIN_EMBEDDING_PROVIDER;
    delete process.env.GBRAIN_EMBEDDING_MODEL;
    delete process.env.GBRAIN_EMBEDDING_DIMENSIONS;
    await loadEmbeddingConfig(mockEngine({
      embedding_provider: 'gemini',
      embedding_model: 'gemini:gemini-embedding-2-preview',
      embedding_dimensions: '1536',
    }));
    const provider = getProvider();
    expect(provider.name).toBe('gemini');
    expect(provider.model).toBe('gemini-embedding-2-preview');
    expect(provider.dimensions).toBe(1536);
  });

  test('env var overrides DB config', async () => {
    process.env.GBRAIN_EMBEDDING_PROVIDER = 'voyage';
    await loadEmbeddingConfig(mockEngine({
      embedding_provider: 'gemini',
      embedding_model: 'gemini:gemini-embedding-2-preview',
      embedding_dimensions: '1536',
    }));
    const provider = getProvider();
    expect(provider.name).toBe('voyage');
    expect(provider.model).toBe('voyage-4-large');
    expect(provider.dimensions).toBe(1024);
  });

  test('defaults when neither env var nor DB config set', async () => {
    delete process.env.GBRAIN_EMBEDDING_PROVIDER;
    delete process.env.GBRAIN_EMBEDDING_MODEL;
    delete process.env.GBRAIN_EMBEDDING_DIMENSIONS;
    await loadEmbeddingConfig(mockEngine({}));
    const provider = getProvider();
    expect(provider.name).toBe('openai');
    expect(provider.model).toBe('text-embedding-3-large');
    expect(provider.dimensions).toBe(1536);
  });

  test('extracts model from provider:model format in DB config', async () => {
    delete process.env.GBRAIN_EMBEDDING_PROVIDER;
    delete process.env.GBRAIN_EMBEDDING_MODEL;
    await loadEmbeddingConfig(mockEngine({
      embedding_provider: 'openai',
      embedding_model: 'openai:text-embedding-3-small',
    }));
    const provider = getProvider();
    expect(provider.model).toBe('text-embedding-3-small');
  });

  test('env var override ignores DB model/dims when DB has no provider (legacy upgrade)', async () => {
    // Simulates: legacy brain with no embedding_provider key, user sets env var
    process.env.GBRAIN_EMBEDDING_PROVIDER = 'voyage';
    delete process.env.GBRAIN_EMBEDDING_MODEL;
    delete process.env.GBRAIN_EMBEDDING_DIMENSIONS;
    await loadEmbeddingConfig(mockEngine({
      // Legacy DB: has model/dims but no provider key
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: '1536',
    }));
    const provider = getProvider();
    // Should use voyage defaults, NOT the old openai model/dims from DB
    expect(provider.name).toBe('voyage');
    expect(provider.model).toBe('voyage-4-large');
    expect(provider.dimensions).toBe(1024);
  });

  test('resetProvider clears DB config cache', async () => {
    delete process.env.GBRAIN_EMBEDDING_PROVIDER;
    await loadEmbeddingConfig(mockEngine({
      embedding_provider: 'voyage',
    }));
    resetProvider();
    // After reset, dbConfig is cleared — should fall back to defaults
    const provider = getProvider();
    expect(provider.name).toBe('openai');
  });
});
