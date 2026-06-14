import { describe, expect, test } from 'bun:test';
import { normalizeEmbeddingDimensions } from '../src/core/embedding.ts';

describe('embedding provider dimension normalization', () => {
  test('pads shorter provider vectors to the target schema dimension', () => {
    const vector = normalizeEmbeddingDimensions([1, 2, 3], 5, 'pad');

    expect(vector).toBeInstanceOf(Float32Array);
    expect(vector.length).toBe(5);
    expect(Array.from(vector)).toEqual([1, 2, 3, 0, 0]);
  });

  test('leaves native provider dimensions untouched when requested', () => {
    const vector = normalizeEmbeddingDimensions([1, 2, 3], 5, 'native');

    expect(vector.length).toBe(3);
    expect(Array.from(vector)).toEqual([1, 2, 3]);
  });

  test('throws on incompatible dimensions when mismatch mode is strict', () => {
    expect(() => normalizeEmbeddingDimensions([1, 2, 3], 5, 'error')).toThrow(
      /Embedding dimension mismatch/,
    );
  });
});
