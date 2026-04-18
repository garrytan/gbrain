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
    expect(p.model).toBe('text-embedding-004');
  });

  it('accepts custom dimensions within range', () => {
    const p = new GeminiEmbedder(256);
    expect(p.dimensions).toBe(256);
  });

  it('throws for dimensions out of range', () => {
    expect(() => new GeminiEmbedder(0)).toThrow();
    expect(() => new GeminiEmbedder(769)).toThrow();
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
});

// ─── isEmbeddingAvailable ───────────────────────────────────────────────────

describe('isEmbeddingAvailable', () => {
  const savedProvider = process.env.GBRAIN_EMBEDDING_PROVIDER;

  afterEach(() => {
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
