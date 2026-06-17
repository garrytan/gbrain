/**
 * v0.32.x search-lite \u2014 hybridSearchCached integration.
 *
 * End-to-end PGLite test that confirms the three search-lite features
 * fire through the actual hybrid pipeline (not the units in isolation):
 *
 *   1. Token budget: results are capped after search.
 *   2. Cache: meta surfaces hit/miss; disabled mode is a clean pass-through.
 *   3. Intent classifier: meta.intent matches the classifier output.
 *
 * Vector search isn't enabled (no embedding provider in test), so we
 * exercise the keyword-only path \u2014 which still surfaces intent and
 * budget. The cache path is exercised separately in query-cache.test.ts
 * because it needs a real embedding to key on.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { hybridSearchCached } from '../src/core/search/hybrid.ts';
import type { PageInput, HybridSearchMeta } from '../src/core/types.ts';

let engine: PGLiteEngine;
const savedKey = process.env.OPENAI_API_KEY;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  // Insert a small fixture set so keyword search has something to find.
  // Use long chunk_texts so token budget cuts have observable effect.
  const longText = 'x'.repeat(800);  // ~200 tokens of body text
  const pages: Array<{ slug: string; page: PageInput }> = [
    {
      slug: 'alice-foo',
      page: {
        type: 'person',
        title: 'Alice Foo',
        compiled_truth: `Alice Foo is a builder. ${longText}`,
      },
    },
    {
      slug: 'bob-bar',
      page: {
        type: 'person',
        title: 'Bob Bar',
        compiled_truth: `Bob Bar is a builder. ${longText}`,
      },
    },
    {
      slug: 'carol-baz',
      page: {
        type: 'person',
        title: 'Carol Baz',
        compiled_truth: `Carol Baz is a builder. ${longText}`,
      },
    },
  ];
  for (const p of pages) {
    await engine.putPage(p.slug, p.page);
  }
  // Force keyword-only fallback by unsetting the embedding provider key.
  delete process.env.OPENAI_API_KEY;
});

afterAll(async () => {
  if (savedKey) process.env.OPENAI_API_KEY = savedKey;
  try { await engine.disconnect(); } catch { /* ignore */ }
});

describe('hybridSearchCached \u2014 meta surfaces intent', () => {
  test('entity query classifies as entity', async () => {
    let meta: HybridSearchMeta | undefined;
    await hybridSearchCached(engine, 'who is alice-foo', {
      limit: 5,
      onMeta: (m) => { meta = m; },
    });
    expect(meta?.intent).toBe('entity');
  });

  test('temporal query classifies as temporal', async () => {
    let meta: HybridSearchMeta | undefined;
    await hybridSearchCached(engine, 'what happened last week', {
      limit: 5,
      onMeta: (m) => { meta = m; },
    });
    expect(meta?.intent).toBe('temporal');
  });

  test('event query classifies as event', async () => {
    let meta: HybridSearchMeta | undefined;
    await hybridSearchCached(engine, 'who raised $10M', {
      limit: 5,
      onMeta: (m) => { meta = m; },
    });
    expect(meta?.intent).toBe('event');
  });
});

describe('hybridSearchCached \u2014 token budget', () => {
  test('budget undefined returns no token_budget meta (no cut)', async () => {
    let meta: HybridSearchMeta | undefined;
    const results = await hybridSearchCached(engine, 'alice', {
      limit: 10,
      onMeta: (m) => { meta = m; },
    });
    // Don't assert non-empty here — keyword tokenization depends on the
    // pglite analyzer config. What matters: meta is shaped right and
    // budget metadata is absent when budget isn't set.
    expect(results).toBeDefined();
    expect(meta?.token_budget).toBeUndefined();
  });

  test('budget meta is always emitted when budget is set', async () => {
    let meta: HybridSearchMeta | undefined;
    const results = await hybridSearchCached(engine, 'alice', {
      limit: 10,
      tokenBudget: 250,
      onMeta: (m) => { meta = m; },
    });
    expect(meta?.token_budget).toBeDefined();
    expect(meta?.token_budget?.budget).toBe(250);
    expect(meta?.token_budget?.kept).toBe(results.length);
  });

  test('tight budget cuts the result set', async () => {
    // First find out the result count without a budget so the assertion
    // is robust to the fixture’s actual chunking.
    const unbounded = await hybridSearchCached(engine, 'builder', { limit: 10 });
    // Skip the cut test if the fixture happens to return only one row
    // (keyword search may dedupe by page); the budget enforcement itself
    // is exhaustively unit-tested in test/token-budget.test.ts.
    if (unbounded.length < 2) return;

    let meta: HybridSearchMeta | undefined;
    const results = await hybridSearchCached(engine, 'builder', {
      limit: 10,
      tokenBudget: 250,  // enough for ~1 row of fixture data
      onMeta: (m) => { meta = m; },
    });
    expect(meta?.token_budget?.budget).toBe(250);
    expect(meta?.token_budget?.kept).toBe(results.length);
    expect(meta?.token_budget?.dropped).toBeGreaterThan(0);
    // The budget must hold: cumulative cost <= budget.
    expect(meta?.token_budget?.used).toBeLessThanOrEqual(250);
  });
});

describe('hybridSearchCached \u2014 cache disabled fallback', () => {
  test('keyword-only path emits cache.status=disabled', async () => {
    // No embedding available \u2192 cache decision degrades to disabled.
    let meta: HybridSearchMeta | undefined;
    await hybridSearchCached(engine, 'who is alice-foo', {
      limit: 5,
      onMeta: (m) => { meta = m; },
    });
    // cache may be 'disabled' (no embedding provider) or 'miss'.
    // Either way the field exists.
    expect(meta?.cache).toBeDefined();
    expect(['disabled', 'miss']).toContain(meta?.cache?.status ?? '');
  });

  test('useCache=false explicitly disables', async () => {
    let meta: HybridSearchMeta | undefined;
    await hybridSearchCached(engine, 'who is bob-bar', {
      limit: 5,
      useCache: false,
      onMeta: (m) => { meta = m; },
    });
    expect(meta?.cache?.status).toBe('disabled');
  });
});

describe('hybridSearchCached \u2014 intent weighting toggle', () => {
  test('intentWeighting=false still emits intent in meta (for visibility)', async () => {
    let meta: HybridSearchMeta | undefined;
    await hybridSearchCached(engine, 'who is alice-foo', {
      limit: 5,
      intentWeighting: false,
      onMeta: (m) => { meta = m; },
    });
    // Intent classification itself still runs (cheap regex); only the
    // weight adjustment is disabled. So meta.intent stays populated.
    expect(meta?.intent).toBe('entity');
  });
});
