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

  test('requests the legacy width from flexible models before deciding to rebuild', async () => {
    configureGateway({
      embedding_model: 'zhipu:embedding-3',
      embedding_dimensions: 1280,
      env: { ZHIPUAI_API_KEY: 'test-key' },
    });
    let providerOptions: unknown;
    __setEmbedTransportForTests(async options => {
      providerOptions = options.providerOptions;
      return {
        embeddings: [new Array(1280).fill(0.1)],
        usage: { tokens: 1 },
        warnings: [],
      } as any;
    });

    expect(await detectEmbeddingDimensions('zhipu:embedding-3', 1280)).toBe(1280);
    expect(providerOptions).toEqual({
      openaiCompatible: { dimensions: 1280 },
    });
  });
});
