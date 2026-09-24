import { afterEach, describe, expect, test } from 'bun:test';
import { configureGateway, resetGateway, embed, __setEmbedTransportForTests } from '../../src/core/ai/gateway.ts';
import { google } from '../../src/core/ai/recipes/google.ts';

afterEach(() => {
  __setEmbedTransportForTests(null);
  resetGateway();
});

describe('Google embedding request item limit', () => {
  test('declares the 100-item provider limit', () => {
    expect(google.touchpoints.embedding?.max_batch_items).toBe(100);
  });

  for (const count of [100, 101, 250]) {
    test(`${count} inputs retain vector identity and order across capped batches`, async () => {
      configureGateway({
        embedding_model: 'google:gemini-embedding-2',
        embedding_dimensions: 768,
        env: { GOOGLE_GENERATIVE_AI_API_KEY: 'test-key' },
      });
      const batches: string[][] = [];
      __setEmbedTransportForTests(async ({ values }: { values: string[] }) => {
        batches.push([...values]);
        expect(values.length).toBeLessThanOrEqual(100);
        return { values, usage: { tokens: values.length }, warnings: [], embeddings: values.map(text => Array(768).fill(Number(text.slice(1)) + 1)) };
      });
      const texts = Array.from({ length: count }, (_, i) => `f${i}`);
      const vectors = await embed(texts);
      expect(batches.map(batch => batch.length)).toEqual(count === 100 ? [100] : count === 101 ? [100, 1] : [100, 100, 50]);
      expect(batches.flat()).toEqual(texts);
      expect(vectors.map(vector => vector[0])).toEqual(texts.map((_, i) => i + 1));
    });
  }
});
