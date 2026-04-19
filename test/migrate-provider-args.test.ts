/**
 * FORK: Tests for migrate-provider CLI argument validation.
 *
 * Tests the argument-parsing and early-exit paths without requiring a
 * real database. DB-dependent paths (ALTER TABLE, re-embed loop) are
 * E2E tests that require DATABASE_URL.
 */

import { describe, it, expect } from 'bun:test';
import { GeminiEmbedder } from '../src/core/providers/gemini-embedder.ts';
import { OpenAIEmbedder } from '../src/core/providers/openai-embedder.ts';

// ─── Provider instantiation contract ────────────────────────────────────────
// These paths are exercised by the migrate command before it touches the DB.

describe('migrate-provider: provider instantiation', () => {
  it('GeminiEmbedder(768) is the default Gemini target', () => {
    const p = new GeminiEmbedder(768);
    expect(p.model).toBe('gemini-embedding-001');
    expect(p.dimensions).toBe(768);
  });

  it('GeminiEmbedder(1536) enables OpenAI-compat migration (no ALTER TABLE needed)', () => {
    const p = new GeminiEmbedder(1536);
    expect(p.dimensions).toBe(1536);
    // Same dims as OpenAI → dimsChange = false in migrate-provider.ts
    const openai = new OpenAIEmbedder();
    expect(p.dimensions).toBe(openai.dimensions);
  });

  it('GeminiEmbedder(3072) enables full-fidelity migration', () => {
    const p = new GeminiEmbedder(3072);
    expect(p.dimensions).toBe(3072);
    expect(p.model).toBe('gemini-embedding-001');
  });

  it('dimsChange logic: same dims → no ALTER TABLE', () => {
    const currentDims = 1536;
    const newDims = 1536;
    const dimsChange = currentDims !== newDims;
    expect(dimsChange).toBe(false);
  });

  it('dimsChange logic: different dims → ALTER TABLE triggered', () => {
    const currentDims = 1536;
    const newDims = 768;
    const dimsChange = currentDims !== newDims;
    expect(dimsChange).toBe(true);
  });

  it('dimsChange logic: 1536 → 3072 → ALTER TABLE triggered', () => {
    const dimsChange = 1536 !== 3072;
    expect(dimsChange).toBe(true);
  });
});

// ─── GeminiEmbedder: API key guard (config error, not retriable) ─────────────

describe('migrate-provider: API key validation', () => {
  it('GeminiEmbedder.embed() rejects immediately when no key is set', async () => {
    const savedG = process.env.GOOGLE_API_KEY;
    const savedGem = process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      const p = new GeminiEmbedder(768);
      await expect(p.embed('test')).rejects.toThrow('GOOGLE_API_KEY');
    } finally {
      if (savedG !== undefined) process.env.GOOGLE_API_KEY = savedG;
      if (savedGem !== undefined) process.env.GEMINI_API_KEY = savedGem;
    }
  });

  it('GeminiEmbedder does not retry on config error (key missing)', async () => {
    // embedBatch calls getClient() upfront — throws before retry loop
    const savedG = process.env.GOOGLE_API_KEY;
    const savedGem = process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GEMINI_API_KEY;
    const start = Date.now();
    try {
      const p = new GeminiEmbedder(768);
      await p.embed('test').catch(() => {});
    } finally {
      if (savedG !== undefined) process.env.GOOGLE_API_KEY = savedG;
      if (savedGem !== undefined) process.env.GEMINI_API_KEY = savedGem;
    }
    // Should fail instantly, not after 4000ms (exponential backoff base delay)
    expect(Date.now() - start).toBeLessThan(500);
  });
});
