import { describe, test, expect } from 'bun:test';
import { OpenAIProvider } from '../../src/core/embedding/openai.ts';

describe('OpenAIProvider', () => {
  test('implements EmbeddingProvider interface', () => {
    const provider = new OpenAIProvider('text-embedding-3-large', 1536);
    expect(provider.name).toBe('openai');
    expect(provider.model).toBe('text-embedding-3-large');
    expect(provider.dimensions).toBe(1536);
    expect(typeof provider.embed).toBe('function');
    expect(typeof provider.embedBatch).toBe('function');
  });

  test('defaults to text-embedding-3-large with 1536 dimensions', () => {
    const provider = new OpenAIProvider();
    expect(provider.model).toBe('text-embedding-3-large');
    expect(provider.dimensions).toBe(1536);
  });
});
