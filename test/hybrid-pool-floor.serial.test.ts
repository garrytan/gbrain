/**
 * D-3002 — pre-fusion candidate-pool floor (PRE_FUSION_POOL_FLOOR).
 *
 * Failing-first target: innerLimit was `Math.min(limit * 2, MAX_SEARCH_LIMIT)`,
 * so a limit=10 search handed every recall arm a 20-row budget. Two user-visible
 * failures fell out of that:
 *
 *   1. RRF fused a starved pool — each arm saw only 2x the page size, so
 *      fusion had almost nothing to re-rank at common limits.
 *   2. Offset pagination fell off a cliff: slice(offset, offset + limit) of a
 *      20-row pool returns EMPTY pages past offset >= limit*2 even when deeper
 *      matches exist in the brain.
 *
 * The fix floors the pool at PRE_FUSION_POOL_FLOOR (50) and at offset + limit,
 * still capped by MAX_SEARCH_LIMIT. Keyless PGLite (no embedding provider)
 * exercises the keyword-only path; innerLimit is computed once at hybridSearch
 * entry, so the shared searchOpts.limit assertion covers every path.
 *
 * Serial: mutates process.env.OPENAI_API_KEY.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { hybridSearch, PRE_FUSION_POOL_FLOOR } from '../src/core/search/hybrid.ts';
import type { SearchOpts, SearchResult } from '../src/core/types.ts';

let engine: PGLiteEngine;
const savedKey = process.env.OPENAI_API_KEY;

// Mixed types keep dedup Layer 3 (no page type above 60% of results) out of
// this test's way — an all-one-type fixture would be diversity-capped and the
// pool size assertions would couple to the dedup policy instead of innerLimit.
const TYPES = ['person', 'company', 'note'] as const;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  // 29 decoys that repeat the common phrase (high ts_rank) + 1 deep target
  // that mentions it exactly once inside unrelated filler (lowest ts_rank →
  // rank 30 of 30 on the common query). The phrase lives ONLY in chunk_text:
  // pages.search_vector indexes title/timeline (not compiled_truth since
  // v124), so the title arm stays empty and the keyword arm is the sole
  // candidate generator — the pool size is then directly observable.
  for (let i = 0; i < 29; i++) {
    const slug = `decoy-${i}`;
    const text =
      `orchard telemetry. ${'orchard telemetry beats manual checks. '.repeat(4)}entry ${i}`;
    await engine.putPage(slug, {
      type: TYPES[i % 3],
      title: `Decoy ${i}`,
      compiled_truth: text,
    });
    // putPage never chunks — searchKeyword joins content_chunks, so pages
    // need explicit chunks to be visible to the keyword arm.
    await engine.upsertChunks(slug, [
      { chunk_index: 0, chunk_text: text, chunk_source: 'compiled_truth' },
    ]);
  }
  const filler =
    'wind rain soil harvest pruning ladder basket season growth cycle '.repeat(12);
  const deepText =
    `${filler}the amethyst waterfall protocol relies on orchard telemetry once. ${filler}`;
  await engine.putPage('deep-target', {
    type: 'note',
    title: 'Deep Target',
    compiled_truth: deepText,
  });
  await engine.upsertChunks('deep-target', [
    { chunk_index: 0, chunk_text: deepText, chunk_source: 'compiled_truth' },
  ]);

  // Force the keyword-only (no embedding provider) path.
  delete process.env.OPENAI_API_KEY;
  // PGLite WASM cold start + full migration chain + 30-page seed can exceed
  // bun's default HOOK budget on loaded machines (bunfig's timeout=60s covers
  // tests, not hooks) — same pattern as brain-allowlist.serial.test.ts.
}, 120_000);

afterAll(async () => {
  if (savedKey) process.env.OPENAI_API_KEY = savedKey;
  try { await engine.disconnect(); } catch { /* ignore */ }
});

/** Spy on the two pre-fusion recall arms; returns captured opts.limit values. */
async function withArmSpies(
  run: () => Promise<void>,
): Promise<{ keyword: number | undefined; titles: number | undefined }> {
  const seen: { keyword: number | undefined; titles: number | undefined } = {
    keyword: undefined,
    titles: undefined,
  };
  const origKeyword = engine.searchKeyword.bind(engine);
  const origTitles = engine.searchTitles.bind(engine);
  const spyable = engine as unknown as {
    searchKeyword: (q: string, o?: SearchOpts) => Promise<SearchResult[]>;
    searchTitles: (q: string, o?: SearchOpts) => Promise<SearchResult[]>;
  };
  spyable.searchKeyword = (q, o) => { seen.keyword = o?.limit; return origKeyword(q, o); };
  spyable.searchTitles = (q, o) => { seen.titles = o?.limit; return origTitles(q, o); };
  try {
    await run();
  } finally {
    // Delete the instance shadows so the prototype methods are restored.
    delete (spyable as Partial<typeof spyable>).searchKeyword;
    delete (spyable as Partial<typeof spyable>).searchTitles;
  }
  return seen;
}

describe('pre-fusion pool floor — recall-arm budget', () => {
  test('searchKeyword and searchTitles receive limit >= PRE_FUSION_POOL_FLOOR at limit=10', async () => {
    expect(PRE_FUSION_POOL_FLOOR).toBe(50);
    const seen = await withArmSpies(async () => {
      await hybridSearch(engine, 'orchard telemetry', { limit: 10 });
    });
    // Pre-floor these were limit*2 = 20.
    expect(seen.keyword).toBeGreaterThanOrEqual(PRE_FUSION_POOL_FLOOR);
    expect(seen.titles).toBeGreaterThanOrEqual(PRE_FUSION_POOL_FLOOR);
  });

  test('offset + limit raises the pool past the floor so deep pages stay reachable', async () => {
    const seen = await withArmSpies(async () => {
      await hybridSearch(engine, 'orchard telemetry', { limit: 10, offset: 55 });
    });
    // max(limit*2=20, floor=50, offset+limit=65) = 65.
    expect(seen.keyword).toBeGreaterThanOrEqual(65);
    expect(seen.titles).toBeGreaterThanOrEqual(65);
  });
});

describe('pre-fusion pool floor — offset pagination', () => {
  test('page 3 (offset=20, limit=10) reaches the deep exact-phrase target', async () => {
    // Sanity: the target is indexed and retrievable by its unique exact phrase.
    const direct = await hybridSearch(engine, 'amethyst waterfall protocol', { limit: 5 });
    expect(direct.map((r) => r.slug)).toContain('deep-target');

    // The target is genuinely deep on the common query: not on page 1.
    const page1 = await hybridSearch(engine, 'orchard telemetry', { limit: 10, offset: 0 });
    expect(page1.length).toBe(10);
    expect(page1.map((r) => r.slug)).not.toContain('deep-target');

    // Page 3 = ranks 21-30. Pre-floor the pool ended at rank 20 (limit*2),
    // so this page came back EMPTY and the target was unreachable at any
    // offset — the failing-first assertion.
    const page3 = await hybridSearch(engine, 'orchard telemetry', { limit: 10, offset: 20 });
    expect(page3.length).toBeGreaterThan(0);
    expect(page3.map((r) => r.slug)).toContain('deep-target');
  });
});
