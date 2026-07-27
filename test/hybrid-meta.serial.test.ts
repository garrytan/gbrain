/**
 * hybridSearch meta-field accuracy (v0.25.0, callback-based API).
 *
 * v0.25.0 keeps hybridSearch's return as `Promise<SearchResult[]>` (so
 * Cathedral II callers stay unchanged) and surfaces meta via an optional
 * `onMeta` callback in HybridSearchOpts. Asserts the callback fires with
 * accurate values:
 *   - vector_enabled=false when OPENAI_API_KEY missing (keyword-only path)
 *   - detail_resolved reflects auto-detect + caller override
 *   - expansion_applied only true when expandFn returned variants
 *
 * Uses PGLite in-memory + no embedding calls (vector path doesn't need
 * real embeddings to test the meta flag since we control the env).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { hybridSearch } from '../src/core/search/hybrid.ts';
import type { PageInput, HybridSearchMeta } from '../src/core/types.ts';

let engine: PGLiteEngine;
const savedKey = process.env.OPENAI_API_KEY;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const page: PageInput = {
    type: 'person',
    title: 'Alice Example',
    compiled_truth: 'Alice Example is a test person for hybrid-meta tests.',
  };
  await engine.putPage('people/alice-example', page);
});

afterAll(async () => {
  if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = savedKey;
  await engine.disconnect();
});

async function runWithMeta(query: string, opts: Parameters<typeof hybridSearch>[2] = {}): Promise<HybridSearchMeta | null> {
  let captured: HybridSearchMeta | null = null;
  await hybridSearch(engine, query, { ...opts, onMeta: (m) => { captured = m; } });
  return captured;
}

describe('hybridSearch return shape (v0.25.0 keeps SearchResult[])', () => {
  test('returns SearchResult[] (unchanged from Cathedral II contract)', async () => {
    delete process.env.OPENAI_API_KEY;
    const out = await hybridSearch(engine, 'alice');
    expect(Array.isArray(out)).toBe(true);
  });
});

describe('hybridSearch onMeta callback — vector_enabled', () => {
  test('false when OPENAI_API_KEY is missing (keyword-only path)', async () => {
    delete process.env.OPENAI_API_KEY;
    const meta = await runWithMeta('alice');
    expect(meta).not.toBeNull();
    expect(meta!.vector_enabled).toBe(false);
  });
});

describe('hybridSearch onMeta callback — detail_resolved', () => {
  test('passes through explicit detail override (caller specified "high")', async () => {
    delete process.env.OPENAI_API_KEY;
    const meta = await runWithMeta('alice', { detail: 'high' });
    expect(meta!.detail_resolved).toBe('high');
  });

  test('detail_resolved reflects autoDetect output when caller omits detail', async () => {
    delete process.env.OPENAI_API_KEY;
    const meta = await runWithMeta('alice');
    expect([null, 'low', 'medium', 'high']).toContain(meta!.detail_resolved);
  });
});

describe('hybridSearch onMeta callback — expansion_applied', () => {
  test('false when expansion flag is off', async () => {
    delete process.env.OPENAI_API_KEY;
    const meta = await runWithMeta('alice', { expansion: false });
    expect(meta!.expansion_applied).toBe(false);
  });

  test('false when OPENAI_API_KEY missing (early-return short-circuits expansion)', async () => {
    delete process.env.OPENAI_API_KEY;
    const meta = await runWithMeta('alice', {
      expansion: true,
      expandFn: async () => ['alice', 'alice example', 'the person alice'],
    });
    expect(meta!.expansion_applied).toBe(false);
  });
});

describe('onMeta callback omitted', () => {
  test('hybridSearch works without onMeta (existing Cathedral II callers unaffected)', async () => {
    delete process.env.OPENAI_API_KEY;
    const out = await hybridSearch(engine, 'alice');
    expect(Array.isArray(out)).toBe(true);
  });
});
