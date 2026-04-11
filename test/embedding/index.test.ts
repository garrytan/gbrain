import { describe, test, expect } from 'bun:test';
import { embed, embedBatch, EMBEDDING_MODEL, EMBEDDING_DIMENSIONS, getProvider } from '../../src/core/embedding/index.ts';

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
