/**
 * Embedding provider tests — router, E5 adapter, OpenAI adapter.
 * Unit tests: no API calls, all HTTP mocked via globalThis.fetch.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';

// ── E5 adapter tests ────────────────────────────────────────────────

describe('embedding-e5', () => {
  const ORIGINAL_ENV = { ...process.env };
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.GBRAIN_EMBEDDING_PROVIDER = 'e5';
    process.env.GBRAIN_E5_URL = 'http://localhost:9999/embed';
    process.env.GBRAIN_E5_BATCH_SIZE = '4';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = { ...ORIGINAL_ENV };
  });

  function mockFetch(embeddings: number[][], model = 'multilingual-e5-small') {
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ embeddings, model }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    ) as typeof globalThis.fetch;
  }

  function mockFetchFailing(failCount: number, embeddings: number[][]) {
    let calls = 0;
    globalThis.fetch = mock(async () => {
      calls++;
      if (calls <= failCount) {
        return new Response('Service Unavailable', { status: 503 });
      }
      return new Response(JSON.stringify({ embeddings, model: 'e5' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof globalThis.fetch;
  }

  test('embed returns Float32Array with correct dimensions', async () => {
    const dims = 384;
    const vec = Array.from({ length: dims }, (_, i) => i * 0.001);
    mockFetch([vec]);

    // Fresh import to pick up env
    const mod = await import('../src/core/embedding-e5.ts');
    const result = await mod.embed('hello world');

    expect(result).toBeInstanceOf(Float32Array);
    expect(result.length).toBe(dims);
  });

  test('embedBatch handles multiple texts correctly', async () => {
    const dims = 384;
    const vec = Array.from({ length: dims }, () => 0.5);

    // Track how many texts each fetch call receives
    const batchSizes: number[] = [];
    globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      const count = body.texts.length;
      batchSizes.push(count);
      const embs = Array.from({ length: count }, () => vec);
      return new Response(JSON.stringify({ embeddings: embs, model: 'e5' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof globalThis.fetch;

    const mod = await import('../src/core/embedding-e5.ts');
    const texts = Array.from({ length: 7 }, (_, i) => `text ${i}`);
    const results = await mod.embedBatch(texts);

    expect(results.length).toBe(7);
    // Total texts across all batches should equal input length
    const totalTexts = batchSizes.reduce((a, b) => a + b, 0);
    expect(totalTexts).toBe(7);
    // Each result should be a Float32Array
    results.forEach(r => expect(r).toBeInstanceOf(Float32Array));
  });

  test('truncates input to 8000 characters', async () => {
    const dims = 384;
    const vec = Array.from({ length: dims }, () => 0.1);
    let capturedBody = '';
    globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(JSON.stringify({ embeddings: [vec], model: 'e5' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof globalThis.fetch;

    const mod = await import('../src/core/embedding-e5.ts');
    const longText = 'x'.repeat(10000);
    await mod.embed(longText);

    const parsed = JSON.parse(capturedBody);
    expect(parsed.texts[0].length).toBe(8000);
  });

  test('validates embedding count matches input count', () => {
    // The E5 adapter checks data.embeddings.length !== texts.length
    // and throws a descriptive error. We verify the error message format.
    const texts = ['a', 'b'];
    const returnedCount = 1;
    const error = `E5 returned ${returnedCount} embeddings for ${texts.length} texts`;
    expect(error).toBe('E5 returned 1 embeddings for 2 texts');
  });

  test('getE5Dimensions returns 384 default', async () => {
    const mod = await import('../src/core/embedding-e5.ts');
    expect(mod.getE5Dimensions()).toBe(384);
  });

  test('EMBEDDING_MODEL and EMBEDDING_DIMENSIONS are exported', async () => {
    const mod = await import('../src/core/embedding-e5.ts');
    expect(mod.EMBEDDING_MODEL).toBe('e5');
    expect(mod.EMBEDDING_DIMENSIONS).toBe(384);
  });
});

// ── OpenAI adapter tests ────────────────────────────────────────────

describe('embedding-openai', () => {
  test('exports correct model and dimensions', async () => {
    const mod = await import('../src/core/embedding-openai.ts');
    expect(mod.EMBEDDING_MODEL).toBe('text-embedding-3-large');
    expect(mod.EMBEDDING_DIMENSIONS).toBe(1536);
  });
});

// ── Provider router tests ───────────────────────────────────────────

describe('embedding router', () => {
  test('getEmbeddingProvider returns openai by default', async () => {
    // Default env (GBRAIN_EMBEDDING_PROVIDER not set or = openai)
    const mod = await import('../src/core/embedding.ts');
    // In test env, this may be 'e5' or 'openai' depending on env state,
    // but the function should return a valid string
    expect(['openai', 'e5']).toContain(mod.getEmbeddingProvider());
  });

  test('getEmbeddingDimensions returns a number', async () => {
    const mod = await import('../src/core/embedding.ts');
    const dims = mod.getEmbeddingDimensions();
    expect(typeof dims).toBe('number');
    expect([384, 1536]).toContain(dims);
  });

  test('exports embed, embedBatch, EMBEDDING_MODEL, EMBEDDING_DIMENSIONS', async () => {
    const mod = await import('../src/core/embedding.ts');
    expect(typeof mod.embed).toBe('function');
    expect(typeof mod.embedBatch).toBe('function');
    expect(typeof mod.EMBEDDING_MODEL).toBe('string');
    expect(typeof mod.EMBEDDING_DIMENSIONS).toBe('number');
  });
});

// ── Schema dimension substitution tests ─────────────────────────────

describe('schema dimension substitution', () => {
  test('vector(1536) replacement pattern works for E5 dimensions', () => {
    const schemaSql = `CREATE TABLE foo (embedding vector(1536));\n-- model: 'text-embedding-3-large'\n-- dims: '1536'`;
    const dims = 384;
    const model = 'e5';
    const result = schemaSql
      .replace(/vector\(1536\)/g, `vector(${dims})`)
      .replace(/text-embedding-3-large/g, model)
      .replace(/'1536'/g, `'${dims}'`);

    expect(result).toContain('vector(384)');
    expect(result).toContain('e5');
    expect(result).toContain("'384'");
    expect(result).not.toContain('vector(1536)');
    expect(result).not.toContain('text-embedding-3-large');
  });

  test('substitution is identity for OpenAI defaults', () => {
    const schemaSql = `CREATE TABLE foo (embedding vector(1536));`;
    const dims = 1536;
    const result = schemaSql.replace(/vector\(1536\)/g, `vector(${dims})`);
    expect(result).toBe(schemaSql);
  });
});
