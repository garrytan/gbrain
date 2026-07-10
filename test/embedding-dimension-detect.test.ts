import { afterEach, describe, expect, test } from 'bun:test';
import {
  __setEmbedTransportForTests,
  configureGateway,
  detectEmbeddingDimensions,
  resetGateway,
} from '../src/core/ai/gateway.ts';

afterEach(() => {
  __setEmbedTransportForTests(null);
  resetGateway();
});

describe('custom embedding dimension detection', () => {
  test('returns the provider response width without trusting the placeholder config', async () => {
    configureGateway({
      embedding_model: 'litellm:private-embedding-model',
      embedding_dimensions: 1024,
      env: {},
    });
    __setEmbedTransportForTests(async () => ({
      embeddings: [new Array(768).fill(0.1)],
      usage: { tokens: 1 },
      warnings: [],
    }) as any);

    expect(await detectEmbeddingDimensions()).toBe(768);
  });
});
