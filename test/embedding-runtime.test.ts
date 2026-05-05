import { afterEach, describe, expect, test } from 'bun:test';

const originalFetch = globalThis.fetch;
const originalOpenAIKey = process.env.OPENAI_API_KEY;

function resetEnv() {
  delete process.env.GBRAIN_EMBED_PROVIDER;
  delete process.env.GBRAIN_EMBEDDING_PROVIDER;
  delete process.env.GBRAIN_EMBED_MODEL;
  delete process.env.GBRAIN_EMBEDDING_MODEL;
  delete process.env.GBRAIN_EMBED_DIMENSIONS;
  delete process.env.GBRAIN_EMBEDDING_DIMENSIONS;
  delete process.env.GBRAIN_EMBED_BASE_URL;
  delete process.env.GBRAIN_EMBEDDING_BASE_URL;
  if (originalOpenAIKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalOpenAIKey;
  globalThis.fetch = originalFetch;
}

afterEach(resetEnv);

describe('embedding runtime configuration', () => {
  test('Ollama is considered configured without OPENAI_API_KEY', async () => {
    delete process.env.OPENAI_API_KEY;
    process.env.GBRAIN_EMBED_PROVIDER = 'ollama';
    process.env.GBRAIN_EMBED_MODEL = 'nomic-embed-text';
    process.env.GBRAIN_EMBED_DIMENSIONS = '768';
    process.env.GBRAIN_EMBED_BASE_URL = 'http://127.0.0.1:11434';

    const { embeddingsConfigured, getEmbeddingConfig } = await import('../src/core/embedding.ts');

    expect(embeddingsConfigured()).toBe(true);
    expect(getEmbeddingConfig()).toMatchObject({
      provider: 'ollama',
      model: 'nomic-embed-text',
      dimensions: 768,
    });
  });

  test('Ollama embedding input is truncated before fetch so oversized code chunks do not hit model context limits', async () => {
    delete process.env.OPENAI_API_KEY;
    process.env.GBRAIN_EMBED_PROVIDER = 'ollama';
    process.env.GBRAIN_EMBED_MODEL = 'nomic-embed-text';
    process.env.GBRAIN_EMBED_DIMENSIONS = '768';
    process.env.GBRAIN_EMBED_BASE_URL = 'http://ollama.test';

    let observedInput = '';
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { input: string[] };
      observedInput = body.input[0] ?? '';
      return new Response(JSON.stringify({ embeddings: [Array.from({ length: 768 }, () => 0.01)] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const { embed } = await import('../src/core/embedding.ts');
    const result = await embed('x'.repeat(50_000));

    expect(result.length).toBe(768);
    expect(observedInput.length).toBeLessThanOrEqual(1800);
  });
});
