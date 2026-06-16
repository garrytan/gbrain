import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  __setEmbedTransportForTests,
  configureGateway,
  embed,
  getEmbeddingFallbackChain,
  resetGateway,
} from '../../src/core/ai/gateway.ts';
import { AIConfigError, AITransientError } from '../../src/core/ai/errors.ts';

function fakeEmbeddings(values: string[], dims = 1536): { embeddings: number[][] } {
  return {
    embeddings: values.map(() => Array.from({ length: dims }, () => 0.1)),
  };
}

function configureWithFallback(fallback = ['ollama:qwen3-embedding:4b']): void {
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    embedding_fallback_chain: fallback,
    env: { OPENAI_API_KEY: 'sk-fake' },
    base_urls: { ollama: 'http://127.0.0.1:11434/v1' },
  });
}

describe('embedding fallback chain', () => {
  beforeEach(() => resetGateway());
  afterEach(() => __setEmbedTransportForTests(null));

  test('getEmbeddingFallbackChain returns [] when unset', () => {
    configureGateway({
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: 1536,
      env: { OPENAI_API_KEY: 'sk-fake' },
    });

    expect(getEmbeddingFallbackChain()).toEqual([]);
  });

  test('getEmbeddingFallbackChain returns configured chain', () => {
    configureWithFallback(['ollama:qwen3-embedding:4b', 'voyage:voyage-3-large']);

    expect(getEmbeddingFallbackChain()).toEqual([
      'ollama:qwen3-embedding:4b',
      'voyage:voyage-3-large',
    ]);
  });

  test('transient primary failure falls through to fallback', async () => {
    configureWithFallback();
    const stub = mock(async ({ values }: { values: string[] }) => {
      if (stub.mock.calls.length === 1) {
        throw new Error('temporary upstream outage');
      }
      return fakeEmbeddings(values);
    });
    __setEmbedTransportForTests(stub as any);

    const vectors = await embed(['fallback probe']);

    expect(vectors).toHaveLength(1);
    expect(vectors[0]).toHaveLength(1536);
    expect(stub.mock.calls.length).toBe(2);
  });

  test('all transient chain links throw the last transient error', async () => {
    configureWithFallback();
    const stub = mock(async () => {
      throw new Error(`temporary outage ${stub.mock.calls.length}`);
    });
    __setEmbedTransportForTests(stub as any);

    await expect(embed(['fallback probe'])).rejects.toBeInstanceOf(AITransientError);
    expect(stub.mock.calls.length).toBe(2);
  });

  test('AIConfigError fails fast and does not consult fallback', async () => {
    configureWithFallback();
    const stub = mock(async () => {
      throw new AIConfigError('bad model id', 'fix the model');
    });
    __setEmbedTransportForTests(stub as any);

    await expect(embed(['fallback probe'])).rejects.toBeInstanceOf(AIConfigError);
    expect(stub.mock.calls.length).toBe(1);
  });

  test('explicit embeddingModel override does not use global fallback chain', async () => {
    configureWithFallback();
    const stub = mock(async () => {
      throw new Error('primary override outage');
    });
    __setEmbedTransportForTests(stub as any);

    await expect(embed(['column probe'], {
      embeddingModel: 'openai:text-embedding-3-large',
      dimensions: 1536,
    })).rejects.toBeInstanceOf(AITransientError);
    expect(stub.mock.calls.length).toBe(1);
  });

  test('primary listed in fallback chain is de-duped', async () => {
    configureWithFallback([
      'openai:text-embedding-3-large',
      'ollama:qwen3-embedding:4b',
    ]);
    const stub = mock(async ({ values }: { values: string[] }) => {
      if (stub.mock.calls.length === 1) {
        throw new Error('temporary upstream outage');
      }
      return fakeEmbeddings(values);
    });
    __setEmbedTransportForTests(stub as any);

    const vectors = await embed(['dedupe probe']);

    expect(vectors).toHaveLength(1);
    expect(stub.mock.calls.length).toBe(2);
  });
});
