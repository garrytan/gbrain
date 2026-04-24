import { describe, test, expect, afterEach } from 'bun:test';
import { resolveEmbeddingModel } from '../src/core/embedding.ts';

describe('resolveEmbeddingModel', () => {
  const original = process.env.GBRAIN_EMBEDDING_MODEL;

  afterEach(() => {
    if (original === undefined) delete process.env.GBRAIN_EMBEDDING_MODEL;
    else process.env.GBRAIN_EMBEDDING_MODEL = original;
  });

  test('defaults to text-embedding-3-large when env var unset', () => {
    delete process.env.GBRAIN_EMBEDDING_MODEL;
    expect(resolveEmbeddingModel()).toBe('text-embedding-3-large');
  });

  test('defaults to text-embedding-3-large when env var is empty string', () => {
    process.env.GBRAIN_EMBEDDING_MODEL = '';
    expect(resolveEmbeddingModel()).toBe('text-embedding-3-large');
  });

  test('defaults to text-embedding-3-large when env var is whitespace', () => {
    process.env.GBRAIN_EMBEDDING_MODEL = '   ';
    expect(resolveEmbeddingModel()).toBe('text-embedding-3-large');
  });

  test('accepts text-embedding-3-small', () => {
    process.env.GBRAIN_EMBEDDING_MODEL = 'text-embedding-3-small';
    expect(resolveEmbeddingModel()).toBe('text-embedding-3-small');
  });

  test('accepts text-embedding-3-large explicitly', () => {
    process.env.GBRAIN_EMBEDDING_MODEL = 'text-embedding-3-large';
    expect(resolveEmbeddingModel()).toBe('text-embedding-3-large');
  });

  test('throws on unsupported model', () => {
    process.env.GBRAIN_EMBEDDING_MODEL = 'text-embedding-ada-002';
    expect(() => resolveEmbeddingModel()).toThrow(/not supported/);
  });

  test('error message lists allowed values', () => {
    process.env.GBRAIN_EMBEDDING_MODEL = 'gpt-4';
    expect(() => resolveEmbeddingModel()).toThrow(
      /text-embedding-3-large.*text-embedding-3-small/,
    );
  });
});
