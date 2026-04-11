import { describe, test, expect } from 'bun:test';
import { GeminiProvider } from '../../src/core/embedding/gemini.ts';

describe('GeminiProvider', () => {
  test('implements EmbeddingProvider interface', () => {
    const provider = new GeminiProvider('gemini-embedding-2-preview', 1536);
    expect(provider.name).toBe('gemini');
    expect(provider.model).toBe('gemini-embedding-2-preview');
    expect(provider.dimensions).toBe(1536);
    expect(typeof provider.embed).toBe('function');
    expect(typeof provider.embedBatch).toBe('function');
  });

  test('defaults to gemini-embedding-2-preview with 1536 dimensions', () => {
    const provider = new GeminiProvider();
    expect(provider.model).toBe('gemini-embedding-2-preview');
    expect(provider.dimensions).toBe(1536);
  });
});
