import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { getProvider, resetProvider } from '../../src/core/embedding/registry.ts';

describe('migration v5: dimension change detection', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    resetProvider();
    // Restore env to original state before each test
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    for (const [key, val] of Object.entries(originalEnv)) {
      process.env[key] = val;
    }
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    resetProvider();
  });

  test('detects dimension mismatch between config and provider', () => {
    process.env.GBRAIN_EMBEDDING_PROVIDER = 'voyage';
    const provider = getProvider();
    const dbDimensions = 1536;
    expect(provider.dimensions).toBe(1024);
    expect(provider.dimensions !== dbDimensions).toBe(true);
  });

  test('no mismatch when dimensions match', () => {
    delete process.env.GBRAIN_EMBEDDING_PROVIDER;
    const provider = getProvider();
    const dbDimensions = 1536;
    expect(provider.dimensions === dbDimensions).toBe(true);
  });

  test('detects model change with same dimensions', () => {
    process.env.GBRAIN_EMBEDDING_PROVIDER = 'gemini';
    const provider = getProvider();
    expect(provider.dimensions).toBe(1536); // same as OpenAI default
    expect(`${provider.name}:${provider.model}`).not.toBe('openai:text-embedding-3-large');
  });
});
