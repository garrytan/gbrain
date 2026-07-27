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
        // Mixed types across the fixture keep dedup Layer 3 (no page type
        // above 60% of results) out of this test's way — an all-person set
        // would be capped to 2 of 3 and couple these assertions to the
        // diversity policy.
        type: 'company',
        title: 'Bob Bar',
        compiled_truth: `Bob Bar is a builder. ${longText}`,
      },
    },
    {
      slug: 'carol-baz',
      page: {
        type: 'note',
        title: 'Carol Baz',
        compiled_truth: `Carol Baz is a builder. ${longText}`,
      },
    },
  ];
  for (const p of pages) {
    await engine.putPage(p.slug, p.page);
    // putPage never chunks — searchKeyword joins content_chunks, so a
    // page without explicit chunks is invisible to the keyword arm and
    // every result-dependent assertion below runs against an empty set.
    // (Pattern: test/chunk-grain-fts.test.ts.)
    await engine.upsertChunks(p.slug, [
      { chunk_index: 0, chunk_text: p.page.compiled_truth!, chunk_source: 'compiled_truth' },
    ]);
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
    // Non-empty matters: pre-fix the fixture had no chunks, so this ran
    // against an empty result set and the absent-budget assertion was
    // trivially true.
    expect(results.length).toBeGreaterThan(0);
    expect(meta?.token_budget).toBeUndefined();
  });

  test('budget meta is always emitted when budget is set', async () => {
    let meta: HybridSearchMeta | undefined;
    const results = await hybridSearchCached(engine, 'alice', {
      limit: 10,
      tokenBudget: 250,
      onMeta: (m) => { meta = m; },
    });
    expect(results.length).toBeGreaterThan(0);
    expect(meta?.token_budget).toBeDefined();
    expect(meta?.token_budget?.budget).toBe(250);
    expect(meta?.token_budget?.kept).toBe(results.length);
  });

  test('tight budget cuts the result set', async () => {
    // All three fixture pages match 'builder' (mixed types, so dedup's
    // type-diversity layer keeps all of them), and the unbounded set MUST
    // have enough rows for the cut to be observable. Pre-fix this was a
    // silent `return` when fewer than 2 rows came back — and with no
    // chunks in the fixture, zero rows ALWAYS came back, so the cut
    // assertions below had never executed anywhere.
    const unbounded = await hybridSearchCached(engine, 'builder', { limit: 10 });
    expect(unbounded.length).toBeGreaterThanOrEqual(2);

    let meta: HybridSearchMeta | undefined;
    const results = await hybridSearchCached(engine, 'builder', {
      limit: 10,
      tokenBudget: 250,  // enough for ~1 row of fixture data
      onMeta: (m) => { meta = m; },
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results.length).toBeLessThan(unbounded.length);
    expect(meta?.token_budget?.budget).toBe(250);
    expect(meta?.token_budget?.kept).toBe(results.length);
    // Exact accounting: every row the budget removed is a reported drop —
    // dropped > 0 alone would accept any wrong positive count (codex).
    expect(meta?.token_budget?.dropped).toBe(unbounded.length - results.length);
    // The budget must hold with a real (non-zero) cost: cumulative cost
    // <= budget, and used=0 would mean the accounting never ran.
    expect(meta?.token_budget?.used).toBeGreaterThan(0);
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
