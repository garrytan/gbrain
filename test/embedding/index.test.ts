import { describe, test, expect, afterEach } from 'bun:test';
import { embed, embedBatch, EMBEDDING_MODEL, EMBEDDING_DIMENSIONS, getProvider, resetProvider } from '../../src/core/embedding/index.ts';

describe('embedding/index re-exports', () => {
  test('exports embed function', () => {
    expect(typeof embed).toBe('function');
  });

  test('exports embedBatch function', () => {
    expect(typeof embedBatch).toBe('function');
  });

  test('exports EMBEDDING_MODEL string', () => {
    expect(typeof EMBEDDING_MODEL).toBe('string');
  });

  test('exports EMBEDDING_DIMENSIONS number', () => {
    expect(typeof EMBEDDING_DIMENSIONS).toBe('number');
  });

  test('exports getProvider function', () => {
    expect(typeof getProvider).toBe('function');
  });
});

describe('embed() empty string handling', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    resetProvider();
  });

  test('returns zero vector for empty string', async () => {
    const result = await embed('');
    expect(result).toBeInstanceOf(Float32Array);
    expect(result.length).toBe(getProvider().dimensions);
    expect(result.every(v => v === 0)).toBe(true);
  });

  test('returns zero vector for whitespace-only string', async () => {
    const result = await embed('   ');
    expect(result).toBeInstanceOf(Float32Array);
    expect(result.length).toBe(getProvider().dimensions);
    expect(result.every(v => v === 0)).toBe(true);
  });
});

describe('embedBatch() empty string handling', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    resetProvider();
  });

  test('returns zero vectors for all-empty batch', async () => {
    const results = await embedBatch(['', '  ', '\t']);
    expect(results.length).toBe(3);
    for (const r of results) {
      expect(r).toBeInstanceOf(Float32Array);
      expect(r.length).toBe(getProvider().dimensions);
      expect(r.every(v => v === 0)).toBe(true);
    }
  });

  test('returns correct number of results for empty batch', async () => {
    const results = await embedBatch([]);
    expect(results.length).toBe(0);
  });
});
