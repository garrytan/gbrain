import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

const originalEnv = { ...process.env };

beforeEach(() => {
  mock.restore();
  process.env = { ...originalEnv };
});

afterEach(() => {
  process.env = { ...originalEnv };
  mock.restore();
});

async function importEmbeddingModule(suffix: string) {
  return import(`../src/core/embedding.ts?${suffix}`) as Promise<typeof import('../src/core/embedding.ts')>;
}

describe('embedding provider selection', () => {
  test('uses a generic OpenAI-compatible embedding provider from env config', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({
        data: [
          { index: 0, embedding: Array.from({ length: 768 }, (_, i) => i / 768) },
          { index: 1, embedding: Array.from({ length: 768 }, (_, i) => (768 - i) / 768) },
        ],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    process.env.GBRAIN_EMBEDDING_PROVIDER = 'openai-compatible';
    process.env.GBRAIN_EMBEDDING_BASE_URL = 'https://embeddings.example.test/v1';
    process.env.GBRAIN_EMBEDDING_API_KEY = 'provider-key';
    process.env.GBRAIN_EMBEDDING_MODEL = 'nomic-embed-text';
    process.env.GBRAIN_EMBEDDING_DIMENSIONS = '768';

    const { embedBatch, getEmbeddingProvider, getEmbeddingModel, getEmbeddingDimensions } = await importEmbeddingModule('generic-provider-test-1');
    const embeddings = await embedBatch(['alpha', 'beta']);

    expect(getEmbeddingProvider()).toBe('openai-compatible');
    expect(getEmbeddingModel()).toBe('nomic-embed-text');
    expect(getEmbeddingDimensions()).toBe(768);
    expect(embeddings).toHaveLength(2);
    expect(embeddings[0].length).toBe(768);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://embeddings.example.test/v1/embeddings');
    expect(calls[0].init?.method).toBe('POST');
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe('Bearer provider-key');
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({
      input: ['alpha', 'beta'],
      model: 'nomic-embed-text',
      dimensions: 768,
    });
  }, 10000);

  test('uses Copilot Blackbird embeddings when GBRAIN_EMBEDDING_PROVIDER=copilot', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({
        embedding_model: 'metis-1024-I16-Binary',
        embeddings: [
          { embedding: Array.from({ length: 1024 }, (_, i) => i / 1024) },
          { embedding: Array.from({ length: 1024 }, (_, i) => (1024 - i) / 1024) },
        ],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    process.env.GBRAIN_EMBEDDING_PROVIDER = 'copilot';
    process.env.GBRAIN_COPILOT_TOKEN = 'test-token';

    const { embedBatch, EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } = await importEmbeddingModule('copilot-test-1');
    const embeddings = await embedBatch(['one', 'two']);

    expect(EMBEDDING_MODEL).toBe('metis-1024-I16-Binary');
    expect(EMBEDDING_DIMENSIONS).toBe(1024);
    expect(embeddings).toHaveLength(2);
    expect(embeddings[0]).toBeInstanceOf(Float32Array);
    expect(embeddings[0].length).toBe(1024);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.github.com/embeddings');
    expect(calls[0].init?.method).toBe('POST');
    expect((calls[0].init?.headers as Record<string, string>)['X-GitHub-Api-Version']).toBe('2025-05-01');
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({
      inputs: ['one', 'two'],
      model: 'metis-1024-I16-Binary',
    });
  }, 10000);

  test('reports Copilot embedding dimension in chunk model metadata', async () => {
    process.env.GBRAIN_EMBEDDING_PROVIDER = 'copilot';
    const { EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } = await importEmbeddingModule('copilot-test-2');

    expect(`${EMBEDDING_MODEL}:${EMBEDDING_DIMENSIONS}`).toBe('metis-1024-I16-Binary:1024');
  });
});
