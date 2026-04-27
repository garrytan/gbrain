/**
 * Tests for the configurable embedding helpers.
 *
 * The functions read `process.env` on each call, so the tests just
 * mutate env vars and reset between cases — no dynamic re-import needed.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { getEmbeddingModel, getEmbeddingDimensions } from '../src/core/embedding-config.ts';

const ENV_KEYS = [
  'GBRAIN_EMBEDDING_MODEL',
  'GBRAIN_EMBEDDING_DIMENSIONS',
  'GBRAIN_EMBEDDING_BASE_URL',
  'GBRAIN_EMBEDDING_API_KEY',
] as const;

describe('embedding config — getEmbeddingModel', () => {
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const k of ENV_KEYS) saved.set(k, process.env[k]);
    for (const k of ENV_KEYS) delete process.env[k];
  });

  afterEach(() => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test('defaults to text-embedding-3-large when env unset', () => {
    expect(getEmbeddingModel()).toBe('text-embedding-3-large');
  });

  test('returns env value when GBRAIN_EMBEDDING_MODEL is set', () => {
    process.env.GBRAIN_EMBEDDING_MODEL = 'bge-m3';
    expect(getEmbeddingModel()).toBe('bge-m3');
  });

  test('falls back to default when env is empty string', () => {
    process.env.GBRAIN_EMBEDDING_MODEL = '';
    expect(getEmbeddingModel()).toBe('text-embedding-3-large');
  });

  test('falls back to default when env is whitespace-only', () => {
    process.env.GBRAIN_EMBEDDING_MODEL = '   ';
    expect(getEmbeddingModel()).toBe('text-embedding-3-large');
  });
});

describe('embedding config — getEmbeddingDimensions', () => {
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const k of ENV_KEYS) saved.set(k, process.env[k]);
    for (const k of ENV_KEYS) delete process.env[k];
  });

  afterEach(() => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test('defaults to 1536 when env unset', () => {
    expect(getEmbeddingDimensions()).toBe(1536);
  });

  test('returns 1024 when GBRAIN_EMBEDDING_DIMENSIONS=1024 (bge-m3)', () => {
    process.env.GBRAIN_EMBEDDING_DIMENSIONS = '1024';
    expect(getEmbeddingDimensions()).toBe(1024);
  });

  test('returns 768 for typical small embedders (nomic-embed-text)', () => {
    process.env.GBRAIN_EMBEDDING_DIMENSIONS = '768';
    expect(getEmbeddingDimensions()).toBe(768);
  });

  test('throws on non-numeric value', () => {
    process.env.GBRAIN_EMBEDDING_DIMENSIONS = 'big';
    expect(() => getEmbeddingDimensions()).toThrow(/must be a positive integer/);
  });

  test('throws on zero', () => {
    process.env.GBRAIN_EMBEDDING_DIMENSIONS = '0';
    expect(() => getEmbeddingDimensions()).toThrow(/must be a positive integer/);
  });

  test('throws on negative number', () => {
    process.env.GBRAIN_EMBEDDING_DIMENSIONS = '-5';
    expect(() => getEmbeddingDimensions()).toThrow(/must be a positive integer/);
  });
});
