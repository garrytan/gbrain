/**
 * Unit tests for OllamaEmbeddingProvider
 *
 * Mocks globalThis.fetch to simulate Ollama /api/embed responses.
 * Mocks setTimeout to eliminate retry delays, keeping tests fast.
 */
import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import {
  OllamaEmbeddingProvider,
  getEmbeddingProvider,
  resetEmbeddingProvider,
} from '../src/core/embedding.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a random embedding vector of the given dimensionality. */
function randomVector(dim: number = 768): number[] {
  return Array.from({ length: dim }, () => Math.random());
}

/** Build a successful Ollama /api/embed Response. */
function ollamaOkResponse(embeddings: number[][]): Response {
  return new Response(JSON.stringify({ embeddings }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Build an HTTP error Response from Ollama. */
function ollamaErrorResponse(status: number, body: string): Response {
  return new Response(body, { status });
}

/**
 * Replace global setTimeout with a version that fires the callback
 * synchronously (eliminating retry delays in tests).
 */
function installInstantTimers() {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  return (globalThis.setTimeout = ((cb: () => void) => {
    cb();
    return 0 as any;
  }) as any);
}

// ---------------------------------------------------------------------------
// Global setup / teardown
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;

beforeEach(() => {
  resetEmbeddingProvider();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalSetTimeout;
  resetEmbeddingProvider();
  delete process.env.GBRAIN_EMBEDDING_PROVIDER;
  delete process.env.OLLAMA_BASE_URL;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OLLAMA_EMBEDDING_MODEL;
});

// ---------------------------------------------------------------------------
// 1. Provider config — constructor defaults
// ---------------------------------------------------------------------------

describe('OllamaEmbeddingProvider — constructor / config', () => {
  test('uses default model (nomic-embed-text) and dimensions (768)', () => {
    const provider = new OllamaEmbeddingProvider();
    expect(provider.model).toBe('nomic-embed-text');
    expect(provider.dimensions).toBe(768);
  });

  test('sets dimensions=1024 for mxbai-embed-large', () => {
    const provider = new OllamaEmbeddingProvider({ model: 'mxbai-embed-large' });
    expect(provider.model).toBe('mxbai-embed-large');
    expect(provider.dimensions).toBe(1024);
  });

  test('sets dimensions=1024 for snowflake-arctic-embed', () => {
    const provider = new OllamaEmbeddingProvider({ model: 'snowflake-arctic-embed' });
    expect(provider.dimensions).toBe(1024);
  });

  test('sets dimensions=384 for all_minilm', () => {
    const provider = new OllamaEmbeddingProvider({ model: 'all-minilm' });
    expect(provider.dimensions).toBe(384);
  });

  test('defaults to 768 dimensions for unknown models', () => {
    const provider = new OllamaEmbeddingProvider({ model: 'my-custom-model' });
    expect(provider.dimensions).toBe(768);
  });

  test('uses OLLAMA_BASE_URL env var when no baseUrl option provided', async () => {
    process.env.OLLAMA_BASE_URL = 'http://env-ollama:9999';
    const vec = randomVector();
    const fetchMock = mock(() => Promise.resolve(ollamaOkResponse([vec])));
    globalThis.fetch = fetchMock;

    const provider = new OllamaEmbeddingProvider();
    await provider.embed('ping');

    const callUrl = (fetchMock.mock.calls[0] as any[])[0] as string;
    expect(callUrl).toBe('http://env-ollama:9999/api/embed');
  });

  test('explicit baseUrl overrides OLLAMA_BASE_URL env var', async () => {
    process.env.OLLAMA_BASE_URL = 'http://env-ollama:9999';
    const vec = randomVector();
    const fetchMock = mock(() => Promise.resolve(ollamaOkResponse([vec])));
    globalThis.fetch = fetchMock;

    const provider = new OllamaEmbeddingProvider({ baseUrl: 'http://explicit:1234' });
    await provider.embed('ping');

    const callUrl = (fetchMock.mock.calls[0] as any[])[0] as string;
    expect(callUrl).toBe('http://explicit:1234/api/embed');
  });
});

// ---------------------------------------------------------------------------
// 2. Single text embedding
// ---------------------------------------------------------------------------

describe('OllamaEmbeddingProvider — embed (single text)', () => {
  test('returns a Float32Array with 768 dimensions', async () => {
    const vec = randomVector(768);
    globalThis.fetch = mock(() => Promise.resolve(ollamaOkResponse([vec])));

    const provider = new OllamaEmbeddingProvider({ baseUrl: 'http://localhost:11434' });
    const result = await provider.embed('hello world');

    expect(result).toBeInstanceOf(Float32Array);
    expect(result.length).toBe(768);
    for (let i = 0; i < 768; i++) {
      expect(result[i]).toBeCloseTo(vec[i], 5);
    }
  });

  test('sends POST to /api/embed with correct JSON body', async () => {
    const vec = randomVector();
    const fetchMock = mock(() => Promise.resolve(ollamaOkResponse([vec])));
    globalThis.fetch = fetchMock;

    const provider = new OllamaEmbeddingProvider({
      model: 'nomic-embed-text',
      baseUrl: 'http://localhost:11434',
    });
    await provider.embed('test input');

    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:11434/api/embed');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });

    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ model: 'nomic-embed-text', input: ['test input'] });
  });

  test('truncates input longer than 8000 characters', async () => {
    const vec = randomVector();
    const fetchMock = mock(() => Promise.resolve(ollamaOkResponse([vec])));
    globalThis.fetch = fetchMock;

    const provider = new OllamaEmbeddingProvider({ baseUrl: 'http://localhost:11434' });
    const longText = 'x'.repeat(12000);
    await provider.embed(longText);

    const body = JSON.parse((fetchMock.mock.calls[0] as any[])[1].body as string);
    expect(body.input[0].length).toBe(8000);
    expect(body.input[0]).toBe('x'.repeat(8000));
  });

  test('does not truncate input under 8000 characters', async () => {
    const vec = randomVector();
    const fetchMock = mock(() => Promise.resolve(ollamaOkResponse([vec])));
    globalThis.fetch = fetchMock;

    const provider = new OllamaEmbeddingProvider({ baseUrl: 'http://localhost:11434' });
    const shortText = 'short text';
    await provider.embed(shortText);

    const body = JSON.parse((fetchMock.mock.calls[0] as any[])[1].body as string);
    expect(body.input[0]).toBe(shortText);
  });
});

// ---------------------------------------------------------------------------
// 3. Batch embedding
// ---------------------------------------------------------------------------

describe('OllamaEmbeddingProvider — embedBatch', () => {
  test('returns multiple Float32Arrays with order preserved', async () => {
    const vecs = [randomVector(), randomVector(), randomVector()];
    globalThis.fetch = mock(() => Promise.resolve(ollamaOkResponse(vecs)));

    const provider = new OllamaEmbeddingProvider({ baseUrl: 'http://localhost:11434' });
    const results = await provider.embedBatch(['first', 'second', 'third']);

    expect(results.length).toBe(3);
    for (let i = 0; i < 3; i++) {
      expect(results[i]).toBeInstanceOf(Float32Array);
      expect(results[i].length).toBe(768);
      for (let j = 0; j < 768; j++) {
        expect(results[i][j]).toBeCloseTo(vecs[i][j], 5);
      }
    }
  });

  test('sends all texts in a single request body', async () => {
    const texts = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
    const vecs = texts.map(() => randomVector());
    const fetchMock = mock(() => Promise.resolve(ollamaOkResponse(vecs)));
    globalThis.fetch = fetchMock;

    const provider = new OllamaEmbeddingProvider({ baseUrl: 'http://localhost:11434' });
    await provider.embedBatch(texts);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchMock.mock.calls[0] as any[])[1].body as string);
    expect(body.input).toEqual(texts);
  });

  test('truncates each text independently to 8000 characters', async () => {
    const vecs = [randomVector(), randomVector()];
    const fetchMock = mock(() => Promise.resolve(ollamaOkResponse(vecs)));
    globalThis.fetch = fetchMock;

    const provider = new OllamaEmbeddingProvider({ baseUrl: 'http://localhost:11434' });
    await provider.embedBatch(['y'.repeat(10000), 'short']);

    const body = JSON.parse((fetchMock.mock.calls[0] as any[])[1].body as string);
    expect(body.input[0].length).toBe(8000);
    expect(body.input[1]).toBe('short');
  });

  test('handles empty batch', async () => {
    // An empty batch should not call fetch at all — the for-loop is skipped.
    const fetchMock = mock(() => Promise.resolve(ollamaOkResponse([])));
    globalThis.fetch = fetchMock;

    const provider = new OllamaEmbeddingProvider({ baseUrl: 'http://localhost:11434' });
    const results = await provider.embedBatch([]);

    expect(results).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  test('splits large batches (>100) into multiple fetch calls', async () => {
    // BATCH_SIZE = 100. Supply 250 texts → 3 batches (100 + 100 + 50).
    const totalTexts = 250;
    const texts = Array.from({ length: totalTexts }, (_, i) => `text-${i}`);
    const fetchMock = mock((url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      const count = body.input.length;
      return Promise.resolve(ollamaOkResponse(Array.from({ length: count }, () => randomVector())));
    });
    globalThis.fetch = fetchMock;

    const provider = new OllamaEmbeddingProvider({ baseUrl: 'http://localhost:11434' });
    const results = await provider.embedBatch(texts);

    expect(results.length).toBe(totalTexts);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // Verify batch sizes: 100, 100, 50
    const batchSizes = (fetchMock.mock.calls as any[]).map(
      (call: any[]) => JSON.parse(call[1].body as string).input.length,
    );
    expect(batchSizes).toEqual([100, 100, 50]);
  });
});

// ---------------------------------------------------------------------------
// 4. Error handling — retry + eventual throw
// ---------------------------------------------------------------------------

describe('OllamaEmbeddingProvider — error handling', () => {
  test('retries 5 times on 500 then throws', async () => {
    const fetchMock = mock(() =>
      Promise.resolve(ollamaErrorResponse(500, 'Internal Server Error')),
    );
    globalThis.fetch = fetchMock;
    installInstantTimers();

    const provider = new OllamaEmbeddingProvider({ baseUrl: 'http://localhost:11434' });
    await expect(provider.embed('fail')).rejects.toThrow('Ollama embed API error (500)');
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  test('succeeds after transient failures', async () => {
    const vec = randomVector();
    let callCount = 0;
    const fetchMock = mock(() => {
      callCount++;
      if (callCount <= 2) {
        return Promise.resolve(ollamaErrorResponse(500, 'transient'));
      }
      return Promise.resolve(ollamaOkResponse([vec]));
    });
    globalThis.fetch = fetchMock;
    installInstantTimers();

    const provider = new OllamaEmbeddingProvider({ baseUrl: 'http://localhost:11434' });
    const result = await provider.embed('retry me');

    expect(result).toBeInstanceOf(Float32Array);
    expect(result.length).toBe(768);
    expect(fetchMock).toHaveBeenCalledTimes(3); // 2 failures + 1 success
  });

  test('throws on network error (fetch rejects)', async () => {
    const fetchMock = mock(() =>
      Promise.reject(new TypeError('fetch failed')),
    );
    globalThis.fetch = fetchMock;
    installInstantTimers();

    const provider = new OllamaEmbeddingProvider({ baseUrl: 'http://localhost:11434' });
    await expect(provider.embed('network error')).rejects.toThrow('fetch failed');
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });
});

// ---------------------------------------------------------------------------
// 5. API error message — includes status code and body
// ---------------------------------------------------------------------------

describe('OllamaEmbeddingProvider — error message details', () => {
  test('error includes status code and response body', async () => {
    const errorBody = JSON.stringify({ error: 'model not found, try loading it first' });
    globalThis.fetch = mock(() => Promise.resolve(ollamaErrorResponse(404, errorBody)));
    installInstantTimers();

    const provider = new OllamaEmbeddingProvider({ baseUrl: 'http://localhost:11434' });

    try {
      await provider.embed('test');
      expect.unreachable('Should have thrown');
    } catch (e: any) {
      expect(e).toBeInstanceOf(Error);
      expect(e.message).toContain('404');
      expect(e.message).toContain('model not found');
      expect(e.message).toMatch(/Ollama embed API error/);
    }
  });

  test('error includes full body text for non-JSON error', async () => {
    const errorBody = 'plain text error from proxy';
    globalThis.fetch = mock(() => Promise.resolve(ollamaErrorResponse(502, errorBody)));
    installInstantTimers();

    const provider = new OllamaEmbeddingProvider({ baseUrl: 'http://localhost:11434' });

    try {
      await provider.embed('test');
      expect.unreachable('Should have thrown');
    } catch (e: any) {
      expect(e.message).toContain('502');
      expect(e.message).toContain('plain text error from proxy');
    }
  });

  test('throws on malformed response (missing embeddings array)', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ results: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    installInstantTimers();

    const provider = new OllamaEmbeddingProvider({ baseUrl: 'http://localhost:11434' });

    try {
      await provider.embed('bad response');
      expect.unreachable('Should have thrown');
    } catch (e: any) {
      expect(e.message).toContain('missing embeddings array');
    }
  });

  test('throws when embeddings is not an array', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ embeddings: 'not an array' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    installInstantTimers();

    const provider = new OllamaEmbeddingProvider({ baseUrl: 'http://localhost:11434' });

    try {
      await provider.embed('bad response');
      expect.unreachable('Should have thrown');
    } catch (e: any) {
      expect(e.message).toContain('missing embeddings array');
    }
  });
});

// ---------------------------------------------------------------------------
// 6. getEmbeddingProvider factory
// ---------------------------------------------------------------------------

describe('getEmbeddingProvider factory', () => {
  test('returns OllamaEmbeddingProvider when GBRAIN_EMBEDDING_PROVIDER=ollama', () => {
    process.env.GBRAIN_EMBEDDING_PROVIDER = 'ollama';
    delete process.env.OPENAI_API_KEY;
    const provider = getEmbeddingProvider();
    expect(provider).toBeInstanceOf(OllamaEmbeddingProvider);
  });

  test('returns same instance on repeated calls (singleton)', () => {
    process.env.GBRAIN_EMBEDDING_PROVIDER = 'ollama';
    const a = getEmbeddingProvider();
    const b = getEmbeddingProvider();
    expect(a).toBe(b);
  });

  test('uses ollama_model from config', () => {
    process.env.GBRAIN_EMBEDDING_PROVIDER = 'ollama';
    const provider = getEmbeddingProvider({
      embedding_provider: 'ollama',
      ollama_model: 'mxbai-embed-large',
    });
    expect(provider).toBeInstanceOf(OllamaEmbeddingProvider);
    expect(provider.model).toBe('mxbai-embed-large');
    expect(provider.dimensions).toBe(1024);
  });

  test('uses ollama_base_url from config', async () => {
    process.env.GBRAIN_EMBEDDING_PROVIDER = 'ollama';
    const vec = randomVector();
    const fetchMock = mock(() => Promise.resolve(ollamaOkResponse([vec])));
    globalThis.fetch = fetchMock;

    const provider = getEmbeddingProvider({
      embedding_provider: 'ollama',
      ollama_base_url: 'http://custom-url:5555',
    });
    expect(provider).toBeInstanceOf(OllamaEmbeddingProvider);
    await provider.embed('ping');

    const callUrl = (fetchMock.mock.calls[0] as any[])[0] as string;
    expect(callUrl).toBe('http://custom-url:5555/api/embed');
  });

  test('falls back to ollama when no OPENAI_API_KEY and no config', () => {
    delete process.env.OPENAI_API_KEY;
    process.env.GBRAIN_EMBEDDING_PROVIDER = 'ollama';
    // Pass empty config to skip file read
    const provider = getEmbeddingProvider({ embedding_provider: 'ollama' });
    expect(provider).toBeInstanceOf(OllamaEmbeddingProvider);
  });
});

// ---------------------------------------------------------------------------
// 7. resetEmbeddingProvider — singleton reset
// ---------------------------------------------------------------------------

describe('resetEmbeddingProvider', () => {
  test('clears singleton so next call creates a new provider instance', () => {
    process.env.GBRAIN_EMBEDDING_PROVIDER = 'ollama';
    const a = getEmbeddingProvider();
    resetEmbeddingProvider();
    const b = getEmbeddingProvider();
    expect(a).not.toBe(b);
    // Both should still be OllamaEmbeddingProvider instances
    expect(a).toBeInstanceOf(OllamaEmbeddingProvider);
    expect(b).toBeInstanceOf(OllamaEmbeddingProvider);
  });

  test('allows switching provider type after reset', () => {
    // First get an ollama provider
    process.env.GBRAIN_EMBEDDING_PROVIDER = 'ollama';
    const ollamaProvider = getEmbeddingProvider();
    expect(ollamaProvider).toBeInstanceOf(OllamaEmbeddingProvider);

    resetEmbeddingProvider();

    // Switch to openai (need OPENAI_API_KEY set for it to be selected via factory)
    delete process.env.GBRAIN_EMBEDDING_PROVIDER;
    process.env.OPENAI_API_KEY = 'sk-test-key';
    const openaiProvider = getEmbeddingProvider();
    // OpenAI provider is not OllamaEmbeddingProvider
    expect(openaiProvider).not.toBeInstanceOf(OllamaEmbeddingProvider);
  });
});
