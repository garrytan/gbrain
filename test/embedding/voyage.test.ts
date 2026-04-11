import { describe, test, expect } from 'bun:test';
import { VoyageProvider } from '../../src/core/embedding/voyage.ts';

describe('VoyageProvider', () => {
  test('implements EmbeddingProvider interface', () => {
    const provider = new VoyageProvider('voyage-3', 1024);
    expect(provider.name).toBe('voyage');
    expect(provider.model).toBe('voyage-3');
    expect(provider.dimensions).toBe(1024);
    expect(typeof provider.embed).toBe('function');
    expect(typeof provider.embedBatch).toBe('function');
  });

  test('defaults to voyage-3 with 1024 dimensions', () => {
    const provider = new VoyageProvider();
    expect(provider.model).toBe('voyage-3');
    expect(provider.dimensions).toBe(1024);
  });
});
