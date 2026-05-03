import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

const ORIGINAL_ENV = {
  GBRAIN_EMBED_PROVIDER: process.env.GBRAIN_EMBED_PROVIDER,
  GBRAIN_EMBED_MODEL: process.env.GBRAIN_EMBED_MODEL,
  GBRAIN_EMBED_DIMENSIONS: process.env.GBRAIN_EMBED_DIMENSIONS,
  GBRAIN_EMBED_INPUT_TYPE: process.env.GBRAIN_EMBED_INPUT_TYPE,
  VOYAGE_API_KEY: process.env.VOYAGE_API_KEY,
};

const originalFetch = globalThis.fetch;

function restoreEnv() {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function freshEmbeddingModule() {
  return await import(`../src/core/embedding.ts?test=${Date.now()}-${Math.random()}`);
}

beforeEach(() => {
  restoreEnv();
});

afterEach(() => {
  restoreEnv();
  globalThis.fetch = originalFetch;
});

describe('embedding provider selection', () => {
  test('Voyage provider calls the Voyage embeddings API and returns configured-dimension vectors', async () => {
    process.env.GBRAIN_EMBED_PROVIDER = 'voyage';
    process.env.GBRAIN_EMBED_MODEL = 'voyage-large-2';
    process.env.GBRAIN_EMBED_DIMENSIONS = '1536';
    process.env.VOYAGE_API_KEY = 'test-voyage-key';

    const calls: Array<{ url: string; body: any; authorization: string | null }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const headers = new Headers(init?.headers);
      calls.push({
        url: String(url),
        body,
        authorization: headers.get('authorization'),
      });
      return new Response(JSON.stringify({
        data: [
          { index: 0, embedding: Array.from({ length: 1536 }, () => 0.25) },
          { index: 1, embedding: Array.from({ length: 1536 }, () => 0.5) },
        ],
        usage: { total_tokens: 4 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;

    const { embedBatch } = await freshEmbeddingModule();

    const embeddings = await embedBatch(['alpha', 'beta']);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.voyageai.com/v1/embeddings');
    expect(calls[0].authorization).toBe('Bearer test-voyage-key');
    expect(calls[0].body).toMatchObject({
      input: ['alpha', 'beta'],
      model: 'voyage-large-2',
      input_type: 'document',
      truncation: true,
    });
    expect(calls[0].body.output_dimension).toBeUndefined();
    expect(embeddings).toHaveLength(2);
    expect(embeddings[0]).toBeInstanceOf(Float32Array);
    expect(embeddings[0]).toHaveLength(1536);
    expect(embeddings[1][0]).toBe(0.5);
  });

  test('Voyage provider fails loudly when returned dimensions do not match GBRAIN_EMBED_DIMENSIONS', async () => {
    process.env.GBRAIN_EMBED_PROVIDER = 'voyage';
    process.env.GBRAIN_EMBED_MODEL = 'voyage-large-2';
    process.env.GBRAIN_EMBED_DIMENSIONS = '1536';
    process.env.VOYAGE_API_KEY = 'test-voyage-key';

    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({
        data: [
          { index: 0, embedding: Array.from({ length: 1024 }, () => 0.25) },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;

    const { embedBatch } = await freshEmbeddingModule();

    await expect(embedBatch(['alpha'])).rejects.toThrow(/Voyage embedding dimension mismatch.*expected 1536.*got 1024/);
  });
});
