import { afterEach, describe, expect, test } from 'bun:test';
import {
  EMBEDDING_DIMENSIONS,
  embedBatch,
  estimateConfiguredEmbeddingCostUsd,
  getEmbeddingModel,
  isEmbeddingConfigured,
} from '../src/core/embedding.ts';

const originalProvider = process.env.GBRAIN_EMBEDDING_PROVIDER;
const originalOpenAIKey = process.env.OPENAI_API_KEY;

afterEach(() => {
  restoreEnv('GBRAIN_EMBEDDING_PROVIDER', originalProvider);
  restoreEnv('OPENAI_API_KEY', originalOpenAIKey);
});

describe('embedding provider selection', () => {
  test('local provider returns deterministic 1536-dim vectors without OpenAI', async () => {
    process.env.GBRAIN_EMBEDDING_PROVIDER = 'local';
    delete process.env.OPENAI_API_KEY;

    expect(isEmbeddingConfigured()).toBe(true);
    expect(getEmbeddingModel()).toBe('local-hash-v1-1536');
    expect(estimateConfiguredEmbeddingCostUsd(1_000_000)).toBe(0);

    const [first, second, repeat] = await embedBatch([
      'GBrain local embeddings for personal search',
      'completely different text',
      'GBrain local embeddings for personal search',
    ]);

    expect(first).toBeInstanceOf(Float32Array);
    expect(first.length).toBe(EMBEDDING_DIMENSIONS);
    expect(second.length).toBe(EMBEDDING_DIMENSIONS);
    expect(Array.from(first)).toEqual(Array.from(repeat));
    expect(Array.from(first)).not.toEqual(Array.from(second));
    expect(vectorMagnitude(first)).toBeCloseTo(1, 5);
  });

  test('OpenAI provider is not configured without OPENAI_API_KEY', async () => {
    process.env.GBRAIN_EMBEDDING_PROVIDER = 'openai';
    delete process.env.OPENAI_API_KEY;

    expect(isEmbeddingConfigured()).toBe(false);
    await expect(embedBatch(['needs a key'])).rejects.toThrow(/OPENAI_API_KEY is required/);
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function vectorMagnitude(vector: Float32Array): number {
  let sum = 0;
  for (const value of vector) sum += value * value;
  return Math.sqrt(sum);
}
