import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { getProvider, resetProvider } from '../../src/core/embedding/registry.ts';

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
    expect(provider.model).toBe('voyage-3');
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
