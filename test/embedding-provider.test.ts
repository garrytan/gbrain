/**
 * FORK: Tests for the provider-agnostic embedding abstraction.
 *
 * No API calls — providers are tested via their interface contract
 * and the factory routing logic. Integration tests (real API) require
 * GOOGLE_API_KEY or OPENAI_API_KEY and are guarded by env checks.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { resetActiveProvider, isEmbeddingAvailable, getActiveProvider } from '../src/core/embedding-provider.ts';
import { OpenAIEmbedder } from '../src/core/providers/openai-embedder.ts';
import { GeminiEmbedder } from '../src/core/providers/gemini-embedder.ts';

// ─── OpenAIEmbedder unit ────────────────────────────────────────────────────

describe('OpenAIEmbedder', () => {
  it('has correct model and dimensions', () => {
    const p = new OpenAIEmbedder();
    expect(p.model).toBe('text-embedding-3-large');
    expect(p.dimensions).toBe(1536);
  });
});

// ─── GeminiEmbedder unit ────────────────────────────────────────────────────

describe('GeminiEmbedder', () => {
  it('defaults to 768 dimensions', () => {
    const p = new GeminiEmbedder();
    expect(p.dimensions).toBe(768);
    expect(p.model).toBe('gemini-embedding-001');
  });

  it('accepts custom dimensions within range', () => {
    expect(new GeminiEmbedder(256).dimensions).toBe(256);
    expect(new GeminiEmbedder(1536).dimensions).toBe(1536); // OpenAI-compat mode
    expect(new GeminiEmbedder(3072).dimensions).toBe(3072); // full fidelity
  });

  it('throws for dimensions out of range', () => {
    expect(() => new GeminiEmbedder(0)).toThrow();
    expect(() => new GeminiEmbedder(3073)).toThrow();
  });

  it('accepts boundary dimensions 1 and 3072', () => {
    expect(() => new GeminiEmbedder(1)).not.toThrow();
    expect(() => new GeminiEmbedder(3072)).not.toThrow();
    expect(new GeminiEmbedder(1).dimensions).toBe(1);
    expect(new GeminiEmbedder(3072).dimensions).toBe(3072);
  });

  it('throws when no API key is set', async () => {
    const saved = process.env.GOOGLE_API_KEY;
    const saved2 = process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      const p = new GeminiEmbedder();
      await expect(p.embed('hello')).rejects.toThrow('GOOGLE_API_KEY');
    } finally {
      if (saved !== undefined) process.env.GOOGLE_API_KEY = saved;
      if (saved2 !== undefined) process.env.GEMINI_API_KEY = saved2;
    }
  });
});

// ─── Factory routing ────────────────────────────────────────────────────────

describe('getActiveProvider factory', () => {
  const savedProvider = process.env.GBRAIN_EMBEDDING_PROVIDER;
  const savedDims = process.env.GBRAIN_EMBEDDING_DIMENSIONS;

  beforeEach(() => resetActiveProvider());

  afterEach(() => {
    resetActiveProvider();
    if (savedProvider !== undefined) {
      process.env.GBRAIN_EMBEDDING_PROVIDER = savedProvider;
    } else {
      delete process.env.GBRAIN_EMBEDDING_PROVIDER;
    }
    if (savedDims !== undefined) {
      process.env.GBRAIN_EMBEDDING_DIMENSIONS = savedDims;
    } else {
      delete process.env.GBRAIN_EMBEDDING_DIMENSIONS;
    }
  });

  it('defaults to OpenAI when GBRAIN_EMBEDDING_PROVIDER is unset', () => {
    delete process.env.GBRAIN_EMBEDDING_PROVIDER;
    const p = getActiveProvider();
    expect(p).toBeInstanceOf(OpenAIEmbedder);
    expect(p.dimensions).toBe(1536);
  });

  it('returns OpenAI when GBRAIN_EMBEDDING_PROVIDER=openai', () => {
    process.env.GBRAIN_EMBEDDING_PROVIDER = 'openai';
    const p = getActiveProvider();
    expect(p).toBeInstanceOf(OpenAIEmbedder);
  });

  it('returns Gemini when GBRAIN_EMBEDDING_PROVIDER=gemini', () => {
    process.env.GBRAIN_EMBEDDING_PROVIDER = 'gemini';
    const p = getActiveProvider();
    expect(p).toBeInstanceOf(GeminiEmbedder);
    expect(p.dimensions).toBe(768);
  });

  it('respects GBRAIN_EMBEDDING_DIMENSIONS for Gemini', () => {
    process.env.GBRAIN_EMBEDDING_PROVIDER = 'gemini';
    process.env.GBRAIN_EMBEDDING_DIMENSIONS = '256';
    const p = getActiveProvider();
    expect(p).toBeInstanceOf(GeminiEmbedder);
    expect(p.dimensions).toBe(256);
  });

  it('caches the provider after first call', () => {
    process.env.GBRAIN_EMBEDDING_PROVIDER = 'openai';
    const p1 = getActiveProvider();
    const p2 = getActiveProvider();
    expect(p1).toBe(p2);
  });

  it('resetActiveProvider allows a new provider to be created', () => {
    process.env.GBRAIN_EMBEDDING_PROVIDER = 'openai';
    const p1 = getActiveProvider();
    resetActiveProvider();
    process.env.GBRAIN_EMBEDDING_PROVIDER = 'gemini';
    const p2 = getActiveProvider();
    expect(p1).not.toBe(p2);
    expect(p2).toBeInstanceOf(GeminiEmbedder);
  });

  it('unknown provider value falls through to OpenAI (safe default)', () => {
    process.env.GBRAIN_EMBEDDING_PROVIDER = 'ollama';
    const p = getActiveProvider();
    expect(p).toBeInstanceOf(OpenAIEmbedder);
  });
});

// ─── GeminiEmbedder behaviour (mock-based, no API key required) ─────────────

describe('GeminiEmbedder embed behaviour', () => {
  it('embed() returns a Float32Array of the requested dimension', async () => {
    const p = new GeminiEmbedder(768);
    // Inject a mock client so no real API call is made
    const fakeVec = new Array(768).fill(0).map((_, i) => i / 768);
    (p as unknown as Record<string, unknown>)['client'] = {
      getGenerativeModel: () => ({
        batchEmbedContents: async () => ({
          embeddings: [{ values: fakeVec }],
        }),
      }),
    };
    const result = await p.embed('test text');
    expect(result).toBeInstanceOf(Float32Array);
    expect(result.length).toBe(768);
    expect(result[1]).toBeCloseTo(1 / 768);
  });

  it('embedBatch() returns one Float32Array per input text', async () => {
    const p = new GeminiEmbedder(768);
    const make = (seed: number) => new Array(768).fill(seed);
    (p as unknown as Record<string, unknown>)['client'] = {
      getGenerativeModel: () => ({
        batchEmbedContents: async ({ requests }: { requests: unknown[] }) => ({
          embeddings: requests.map((_, i) => ({ values: make(i) })),
        }),
      }),
    };
    const vecs = await p.embedBatch(['hello', 'world', 'gbrain']);
    expect(vecs.length).toBe(3);
    for (const v of vecs) {
      expect(v).toBeInstanceOf(Float32Array);
      expect(v.length).toBe(768);
    }
    expect(vecs[0][0]).not.toBe(vecs[1][0]);
  });

  it('embed() with 1536 dims (OpenAI-compat mode) returns correct length', async () => {
    const p = new GeminiEmbedder(1536);
    const fakeVec = new Array(1536).fill(0.1);
    (p as unknown as Record<string, unknown>)['client'] = {
      getGenerativeModel: () => ({
        batchEmbedContents: async () => ({ embeddings: [{ values: fakeVec }] }),
      }),
    };
    const result = await p.embed('test');
    expect(result.length).toBe(1536);
  });

  it('throws a clear error when no API key is set', async () => {
    const saved = { g: process.env.GOOGLE_API_KEY, gem: process.env.GEMINI_API_KEY };
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      const p = new GeminiEmbedder(768);
      await expect(p.embed('test')).rejects.toThrow(/GOOGLE_API_KEY|GEMINI_API_KEY/);
    } finally {
      if (saved.g !== undefined) process.env.GOOGLE_API_KEY = saved.g;
      if (saved.gem !== undefined) process.env.GEMINI_API_KEY = saved.gem;
    }
  });
});

// ─── isEmbeddingAvailable ───────────────────────────────────────────────────

describe('isEmbeddingAvailable', () => {
  let savedProvider: string | undefined;

  beforeEach(() => {
    savedProvider = process.env.GBRAIN_EMBEDDING_PROVIDER;
    resetActiveProvider();
  });

  afterEach(() => {
    resetActiveProvider();
    if (savedProvider !== undefined) {
      process.env.GBRAIN_EMBEDDING_PROVIDER = savedProvider;
    } else {
      delete process.env.GBRAIN_EMBEDDING_PROVIDER;
    }
  });

  it('returns true when OPENAI_API_KEY is set (openai provider)', () => {
    delete process.env.GBRAIN_EMBEDDING_PROVIDER;
    const saved = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-test';
    expect(isEmbeddingAvailable()).toBe(true);
    if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
    else delete process.env.OPENAI_API_KEY;
  });

  it('returns false when OPENAI_API_KEY is absent (openai provider)', () => {
    delete process.env.GBRAIN_EMBEDDING_PROVIDER;
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    expect(isEmbeddingAvailable()).toBe(false);
    if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
  });

  it('returns true when GOOGLE_API_KEY is set (gemini provider)', () => {
    process.env.GBRAIN_EMBEDDING_PROVIDER = 'gemini';
    const saved = process.env.GOOGLE_API_KEY;
    process.env.GOOGLE_API_KEY = 'AIza-test';
    expect(isEmbeddingAvailable()).toBe(true);
    if (saved !== undefined) process.env.GOOGLE_API_KEY = saved;
    else delete process.env.GOOGLE_API_KEY;
  });

  it('returns true when GEMINI_API_KEY is set (gemini provider)', () => {
    process.env.GBRAIN_EMBEDDING_PROVIDER = 'gemini';
    const saved = process.env.GEMINI_API_KEY;
    const savedGoogle = process.env.GOOGLE_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    process.env.GEMINI_API_KEY = 'AIza-test';
    expect(isEmbeddingAvailable()).toBe(true);
    if (saved !== undefined) process.env.GEMINI_API_KEY = saved;
    else delete process.env.GEMINI_API_KEY;
    if (savedGoogle !== undefined) process.env.GOOGLE_API_KEY = savedGoogle;
  });

  it('unknown provider falls through to OpenAI key check', () => {
    process.env.GBRAIN_EMBEDDING_PROVIDER = 'ollama';
    const saved = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-test';
    expect(isEmbeddingAvailable()).toBe(true);
    if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
    else delete process.env.OPENAI_API_KEY;
  });

  it('returns false when no key is set (gemini provider)', () => {
    process.env.GBRAIN_EMBEDDING_PROVIDER = 'gemini';
    const savedG = process.env.GOOGLE_API_KEY;
    const savedGem = process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GEMINI_API_KEY;
    expect(isEmbeddingAvailable()).toBe(false);
    if (savedG !== undefined) process.env.GOOGLE_API_KEY = savedG;
    if (savedGem !== undefined) process.env.GEMINI_API_KEY = savedGem;
  });
});
