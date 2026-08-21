/**
 * #3871 — query-cache scope isolation (poisoned-row regression).
 *
 * Pre-fix, an UNSCOPED search (neither sourceId nor sourceIds) keyed its
 * cache row to 'default' — the same key a scalar `sourceId: 'default'`
 * read uses. An unscoped search reads ALL sources, so its stored result
 * set can carry rows from every source; serving that row to a scoped read
 * is a cross-source leak. Two layers close it:
 *
 *   1. Key split: unscoped now keys to '__unscoped__', so unscoped writes
 *      and default-source-scoped reads can never share a row again.
 *   2. Hit-path re-filter: the hit path re-filters stored rows by the
 *      CALLER's scope before offset/limit paging, so even a legacy row
 *      poisoned under the pre-fix key scheme yields no foreign rows.
 *
 * This file drives real store→hit roundtrips through hybridSearchCached
 * (mocked embedQuery for a deterministic vector, real PGLite
 * SemanticQueryCache) and pins both layers.
 *
 * Serial: mock.module + gateway/global-env mutation (isolation guard R2).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, mock, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as realEmbedding from '../src/core/embedding.ts';
import type { HybridSearchMeta, SearchResult } from '../src/core/types.ts';

/** Deterministic 1536d unit vector — identical for every call, so the
 * second consult matches the first write at cosine 1.0. */
function fixedEmbedding(): Float32Array {
  const arr = new Float32Array(1536);
  for (let i = 0; i < 1536; i++) arr[i] = Math.sin(1 + i * 0.001);
  let norm = 0;
  for (let i = 0; i < 1536; i++) norm += arr[i] * arr[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < 1536; i++) arr[i] /= norm;
  return arr;
}

// Mock BEFORE importing hybrid.ts (spread keeps every other export live).
mock.module('../src/core/embedding.ts', () => ({
  ...realEmbedding,
  embed: async () => fixedEmbedding(),
  embedQuery: async () => fixedEmbedding(),
}));

// Import AFTER mocking.
const { hybridSearchCached, awaitPendingSearchCacheWrites } =
  await import('../src/core/search/hybrid.ts');
const { configureGateway, resetGateway } = await import('../src/core/ai/gateway.ts');
const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');

// Cold-start PGLite schema setup (beforeAll) can exceed bun's 5s default
// hook budget on a fresh checkout; same bump pattern as
// test/scripts/check-engine-dynamic-import.test.ts.
setDefaultTimeout(30_000);

let engine: InstanceType<typeof PGLiteEngine>;
let tmpHome: string;
const savedGbrainHome = process.env.GBRAIN_HOME;

beforeAll(async () => {
  // Hermetic config home so the developer's real ~/.gbrain/config.json
  // can't leak an embedding_model that flips the cache consult to
  // 'disabled' via isCacheSafe.
  tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-cache-scope-poison-'));
  process.env.GBRAIN_HOME = tmpHome;

  // Pin the gateway to a 1536d provider BEFORE initSchema so the
  // query_cache.embedding column is sized for the mock vectors. The fake
  // key is never used — embedQuery is mocked above.
  resetGateway();
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    env: { OPENAI_API_KEY: 'sk-fake' },
  });

  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  // Keyword-findable pages in the DEFAULT source. putPage never chunks —
  // searchKeyword joins content_chunks, so chunks are explicit.
  const fixtures: Array<[string, string, string]> = [
    ['alice-foo', 'Alice Foo', 'person'],
    ['bob-bar', 'Bob Bar', 'company'],
  ];
  for (const [slug, title, type] of fixtures) {
    const truth = `${title} is a builder.`;
    await engine.putPage(slug, { type, title, compiled_truth: truth });
    await engine.upsertChunks(slug, [
      { chunk_index: 0, chunk_text: truth, chunk_source: 'compiled_truth' },
    ]);
  }
});

afterAll(async () => {
  if (savedGbrainHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = savedGbrainHome;
  try { await engine.disconnect(); } catch { /* ignore */ }
  resetGateway();
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

beforeEach(async () => {
  // Each test builds its own cache state from empty.
  await engine.executeRaw('DELETE FROM query_cache');
});

describe('cache scope-key split (#3871 layer 1)', () => {
  test('an unscoped write is keyed __unscoped__ and never serves a scoped read', async () => {
    // Unscoped search (reads all sources) → miss → cache write.
    let unscopedMeta: HybridSearchMeta | undefined;
    const unscopedResults = await hybridSearchCached(engine, 'builder', {
      limit: 10,
      onMeta: (m) => { unscopedMeta = m; },
    });
    expect(unscopedResults.length).toBeGreaterThan(0);
    expect(unscopedMeta?.cache?.status).toBe('miss');
    await awaitPendingSearchCacheWrites();

    // The stored row keys to the sentinel, NOT to 'default'.
    const rows = await engine.executeRaw<{ source_id: string }>(
      'SELECT source_id FROM query_cache',
    );
    expect(rows.length).toBe(1);
    expect(rows[0].source_id).toBe('__unscoped__');

    // A scoped `sourceId: 'default'` read with the identical embedding +
    // knobs must MISS — pre-fix both keyed 'default' and this was a HIT
    // serving the all-sources row.
    let scopedMeta: HybridSearchMeta | undefined;
    await hybridSearchCached(engine, 'builder', {
      limit: 10,
      sourceId: 'default',
      onMeta: (m) => { scopedMeta = m; },
    });
    expect(scopedMeta?.cache?.status).toBe('miss');
  });

  test('a later unscoped read still hits its own row', async () => {
    await hybridSearchCached(engine, 'builder', { limit: 10 });
    await awaitPendingSearchCacheWrites();

    let hitMeta: HybridSearchMeta | undefined;
    const results = await hybridSearchCached(engine, 'builder', {
      limit: 10,
      onMeta: (m) => { hitMeta = m; },
    });
    expect(hitMeta?.cache?.status).toBe('hit');
    expect(results.length).toBeGreaterThan(0);
  });
});

describe('poisoned default-key row (#3871 layer 2 — hit-path re-filter)', () => {
  test('a poisoned row under the default key yields no foreign rows to a scoped read', async () => {
    // 1. Scoped miss-run writes a legitimate row under scope key 'default'.
    let missMeta: HybridSearchMeta | undefined;
    const missResults = await hybridSearchCached(engine, 'builder', {
      limit: 10,
      sourceId: 'default',
      onMeta: (m) => { missMeta = m; },
    });
    expect(missMeta?.cache?.status).toBe('miss');
    expect(missResults.length).toBeGreaterThan(0);
    await awaitPendingSearchCacheWrites();

    // 2. Poison the stored row the way a pre-fix unscoped write would have:
    //    splice foreign-source rows into its results payload. (Pre-fix,
    //    unscoped all-sources writes landed on this exact key.)
    const stored = await engine.executeRaw<{ id: string; results: unknown }>(
      `SELECT id, results FROM query_cache WHERE source_id = 'default'`,
    );
    expect(stored.length).toBe(1);
    const storedResults: SearchResult[] =
      typeof stored[0].results === 'string'
        ? JSON.parse(stored[0].results)
        : (stored[0].results as SearchResult[]);
    const foreignRow: SearchResult = {
      slug: 'secret/leak',
      page_id: 9999,
      title: 'Team Secret Leak',
      type: 'note',
      chunk_text: 'a secret builder note from another source',
      chunk_source: 'compiled_truth',
      chunk_id: 9999,
      chunk_index: 0,
      score: 99, // ranks first — pre-fix it would lead the served page
      stale: false,
      source_id: 'team-secret',
    };
    const poisoned = [foreignRow, ...storedResults];
    // $N::text::jsonb — binds as text, the cast parses it (jsonb rule).
    await engine.executeRaw(
      `UPDATE query_cache SET results = $1::text::jsonb WHERE id = $2`,
      [JSON.stringify(poisoned), stored[0].id],
    );

    // 3. Scoped read again: identical embedding + knobs + scope key → HIT
    //    (this exercises the hit path, not a fresh search) — but the
    //    re-filter must drop every foreign row before paging.
    let hitMeta: HybridSearchMeta | undefined;
    const hitResults = await hybridSearchCached(engine, 'builder', {
      limit: 10,
      sourceId: 'default',
      onMeta: (m) => { hitMeta = m; },
    });
    expect(hitMeta?.cache?.status).toBe('hit');
    expect(hitResults.length).toBeGreaterThan(0);
    expect(hitResults.some((r) => r.source_id === 'team-secret')).toBe(false);
    expect(hitResults.some((r) => r.slug === 'secret/leak')).toBe(false);
    // The legitimate default-source rows still come through.
    const slugs = hitResults.map((r) => r.slug).sort();
    expect(slugs).toEqual(missResults.map((r) => r.slug).sort());
  });

  test('the re-filter runs BEFORE offset/limit paging (foreign rows cannot displace page 1)', async () => {
    // Seed a legitimate scoped row, then poison it with MANY leading
    // foreign rows. If the filter ran after the slice, limit=1 would page
    // a foreign row (or an empty page); filtering first must return the
    // top legitimate row.
    await hybridSearchCached(engine, 'builder', { limit: 1, sourceId: 'default' });
    await awaitPendingSearchCacheWrites();

    const stored = await engine.executeRaw<{ id: string; results: unknown }>(
      `SELECT id, results FROM query_cache WHERE source_id = 'default'`,
    );
    expect(stored.length).toBe(1);
    const storedResults: SearchResult[] =
      typeof stored[0].results === 'string'
        ? JSON.parse(stored[0].results)
        : (stored[0].results as SearchResult[]);
    const foreign: SearchResult[] = Array.from({ length: 5 }, (_, i) => ({
      slug: `secret/leak-${i}`,
      page_id: 9000 + i,
      title: `Leak ${i}`,
      type: 'note',
      chunk_text: `secret ${i}`,
      chunk_source: 'compiled_truth',
      chunk_id: 9000 + i,
      chunk_index: 0,
      score: 99 - i,
      stale: false,
      source_id: 'team-secret',
    }));
    await engine.executeRaw(
      `UPDATE query_cache SET results = $1::text::jsonb WHERE id = $2`,
      [JSON.stringify([...foreign, ...storedResults]), stored[0].id],
    );

    let hitMeta: HybridSearchMeta | undefined;
    const hitResults = await hybridSearchCached(engine, 'builder', {
      limit: 1,
      sourceId: 'default',
      onMeta: (m) => { hitMeta = m; },
    });
    expect(hitMeta?.cache?.status).toBe('hit');
    expect(hitResults.length).toBe(1);
    expect(hitResults[0].source_id ?? 'default').toBe('default');
    expect(hitResults[0].slug.startsWith('secret/')).toBe(false);
  });
});

describe('offset pages bypass the cache (wave-D review)', () => {
  test('a page-2 read after a page-1 write reaches the engine — no poisoned empty page', async () => {
    // Page 1 (offset 0, limit 1): miss → the SLICED page is what gets stored.
    let p1Meta: HybridSearchMeta | undefined;
    const page1 = await hybridSearchCached(engine, 'builder', {
      limit: 1,
      onMeta: (m) => { p1Meta = m; },
    });
    expect(p1Meta?.cache?.status).toBe('miss');
    expect(page1.length).toBe(1);
    await awaitPendingSearchCacheWrites();
    const afterP1 = await engine.executeRaw<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM query_cache`,
    );
    expect(afterP1[0].n).toBe(1);

    // Page 2 (offset 1, limit 1): identical embedding + knobs (offset is NOT
    // in the knobs hash). Pre-fix this HIT the page-1 row and re-sliced the
    // already-sliced 1-row page → an empty page-2 forever. Post-fix the
    // cache is bypassed entirely and the engine serves the real second row.
    let p2Meta: HybridSearchMeta | undefined;
    const page2 = await hybridSearchCached(engine, 'builder', {
      limit: 1,
      offset: 1,
      onMeta: (m) => { p2Meta = m; },
    });
    expect(p2Meta?.cache?.status).toBe('disabled');
    expect(page2.length).toBe(1);
    expect(page2[0].slug).not.toBe(page1[0].slug);

    // The bypass covers the STORE too: the page-2 read banks no row (a
    // stored page-2 slice under the shared knobs hash would poison offset-0
    // reads the same way).
    await awaitPendingSearchCacheWrites();
    const afterP2 = await engine.executeRaw<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM query_cache`,
    );
    expect(afterP2[0].n).toBe(1);

    // Page-1 semantics unchanged: a repeat offset-0 read still hits and
    // serves the same page.
    let p1AgainMeta: HybridSearchMeta | undefined;
    const page1Again = await hybridSearchCached(engine, 'builder', {
      limit: 1,
      onMeta: (m) => { p1AgainMeta = m; },
    });
    expect(p1AgainMeta?.cache?.status).toBe('hit');
    expect(page1Again.map((r) => r.slug)).toEqual(page1.map((r) => r.slug));
  });
});
