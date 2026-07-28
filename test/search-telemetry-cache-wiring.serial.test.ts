/**
 * Regression wiring test for #2952 — cache classification reaches telemetry.
 *
 * Pre-fix, `recordSearchTelemetry` fired only from bare `hybridSearch`, whose
 * meta never carries a `cache` field, and a cache HIT returned from
 * `hybridSearchCached` before any record at all. Net effect on a live brain:
 * `search stats` reported `0 hit / 0 miss` forever while the `query_cache`
 * table grew, and hit searches vanished from count/results/tokens/rank-1.
 *
 * This file drives the REAL pipeline (PGLite brain, real SemanticQueryCache
 * store→lookup roundtrip, mocked `embedQuery` for a deterministic vector) and
 * pins the decision matrix:
 *
 *   - consulted + no row  → recorded once with cache_miss
 *   - consulted + row     → recorded once with cache_hit (plus results/rank-1)
 *   - consult skipped     → recorded once with neither counter
 *   - bare hybridSearch   → recorded once with neither counter (unchanged)
 *
 * Serial: mock.module + gateway/global-env mutation (isolation guard R2).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as realEmbedding from '../src/core/embedding.ts';

/** Deterministic 1536d unit vector — same for every call, so an identical
 * query's second consult matches its first write at cosine 1.0. */
function fixedEmbedding(): Float32Array {
  const arr = new Float32Array(1536);
  for (let i = 0; i < 1536; i++) arr[i] = Math.sin(1 + i * 0.001);
  let norm = 0;
  for (let i = 0; i < 1536; i++) norm += arr[i] * arr[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < 1536; i++) arr[i] /= norm;
  return arr;
}

// Pluggable behavior so individual tests can simulate an embed-provider
// failure (the 'disabled'-via-catch flavor). null → deterministic vector.
let embedBehavior: (() => Promise<Float32Array>) | null = null;

// Mock the embedding seam BEFORE importing hybrid.ts so both the cache-lookup
// embed and the inner vector-arm embed resolve without a provider call. Spread
// the real module so every other export stays live.
mock.module('../src/core/embedding.ts', () => ({
  ...realEmbedding,
  embed: async () => (embedBehavior ? embedBehavior() : fixedEmbedding()),
  embedQuery: async () => (embedBehavior ? embedBehavior() : fixedEmbedding()),
}));

// Import AFTER mocking.
const { hybridSearch, hybridSearchCached, awaitPendingSearchCacheWrites, _resetPendingSearchCacheWritesForTests } =
  await import('../src/core/search/hybrid.ts');
const { getTelemetryWriter, _resetTelemetryWriterForTest } = await import('../src/core/search/telemetry.ts');
const { configureGateway, resetGateway } = await import('../src/core/ai/gateway.ts');
const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');

let engine: InstanceType<typeof PGLiteEngine>;
let tmpHome: string;
const savedGbrainHome = process.env.GBRAIN_HOME;

interface Counters {
  c: number;
  hit: number;
  miss: number;
  rank1: number;
  results: number;
  tokens: number;
}

/** Flush the writer and read the summed counters back from the table. */
async function readCounters(): Promise<Counters> {
  await getTelemetryWriter().flush();
  const rows = await engine.executeRaw<Counters>(
    `SELECT COALESCE(SUM(count), 0)::int        AS c,
            COALESCE(SUM(cache_hit), 0)::int    AS hit,
            COALESCE(SUM(cache_miss), 0)::int   AS miss,
            COALESCE(SUM(count_rank1), 0)::int  AS rank1,
            COALESCE(SUM(sum_results), 0)::int  AS results,
            COALESCE(SUM(sum_tokens), 0)::int   AS tokens
       FROM search_telemetry`,
  );
  return rows[0];
}

beforeAll(async () => {
  // Hermetic config home so the developer's real ~/.gbrain/config.json can't
  // leak an embedding_model that flips isCacheSafe → 'disabled'.
  tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-cache-telemetry-'));
  process.env.GBRAIN_HOME = tmpHome;

  // Pin the gateway to a 1536d provider BEFORE initSchema so the
  // query_cache.embedding column is sized for the mock vectors, and so
  // isAvailable('embedding') lets the cache consult proceed. The fake key is
  // never used — embedQuery is mocked above. (Pattern:
  // test/query-cache-knobs-hash.serial.test.ts.)
  resetGateway();
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    env: { OPENAI_API_KEY: 'sk-fake' },
  });

  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  // Keyword-findable fixtures so the inner search returns rows (a non-empty
  // result set is what arms the cache writeback). searchKeyword joins
  // content_chunks, so pages need explicit chunks — putPage alone leaves the
  // chunk table empty (pattern: test/chunk-grain-fts.test.ts).
  await engine.putPage('alice-foo', {
    type: 'person',
    title: 'Alice Foo',
    compiled_truth: 'Alice Foo is a builder who ships search telemetry fixtures.',
  });
  await engine.upsertChunks('alice-foo', [
    { chunk_index: 0, chunk_text: 'Alice Foo is a builder who ships search telemetry fixtures.', chunk_source: 'compiled_truth' },
  ]);
  await engine.putPage('bob-bar', {
    type: 'person',
    title: 'Bob Bar',
    compiled_truth: 'Bob Bar is a builder who reviews cache wiring fixtures.',
  });
  await engine.upsertChunks('bob-bar', [
    { chunk_index: 0, chunk_text: 'Bob Bar is a builder who reviews cache wiring fixtures.', chunk_source: 'compiled_truth' },
  ]);
});

afterAll(async () => {
  if (savedGbrainHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = savedGbrainHome;
  try { await engine.disconnect(); } catch { /* ignore */ }
  resetGateway();
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

beforeEach(async () => {
  embedBehavior = null;
  _resetTelemetryWriterForTest();
  _resetPendingSearchCacheWritesForTests();
  await engine.executeRaw('DELETE FROM search_telemetry');
  await engine.executeRaw('DELETE FROM query_cache');
});

describe('hybridSearchCached — telemetry carries the cache outcome', () => {
  test('miss then hit: one record per search, classified, hit keeps results/rank-1 telemetry', async () => {
    // Call 1 — cache consulted, empty → miss.
    const first = await hybridSearchCached(engine, 'alice telemetry fixtures', { limit: 5 });
    expect(first.length).toBeGreaterThan(0);
    await awaitPendingSearchCacheWrites();

    // Sanity: the writeback actually landed, so call 2 exercises a REAL hit
    // (a broken writeback would otherwise fail the hit assertion ambiguously).
    const cacheRows = await engine.executeRaw<{ n: number }>(
      'SELECT COUNT(*)::int AS n FROM query_cache',
    );
    expect(cacheRows[0].n).toBeGreaterThan(0);

    const afterMiss = await readCounters();
    expect(afterMiss.c).toBe(1);
    expect(afterMiss.miss).toBe(1);
    expect(afterMiss.hit).toBe(0);
    expect(afterMiss.rank1).toBe(1);
    expect(afterMiss.results).toBeGreaterThan(0);

    // Call 2 — identical query + knobs, deterministic embedding → hit.
    let meta: import('../src/core/types.ts').HybridSearchMeta | undefined;
    const second = await hybridSearchCached(engine, 'alice telemetry fixtures', {
      limit: 5,
      onMeta: (m) => { meta = m; },
    });
    expect(meta?.cache?.status).toBe('hit');
    expect(second.length).toBeGreaterThan(0);

    const afterHit = await readCounters();
    // Pre-fix both sides of this were wrong: hit stayed 0 forever AND the hit
    // search was missing from count entirely (c would read 1, not 2).
    expect(afterHit.c).toBe(2);
    expect(afterHit.miss).toBe(1);
    expect(afterHit.hit).toBe(1);
    // The hit search contributes results/rank-1/tokens telemetry too.
    expect(afterHit.rank1).toBe(2);
    expect(afterHit.results).toBeGreaterThan(afterMiss.results);
    // Token parity (codex): the hit serves the SAME result set the miss
    // stored, so its token contribution must EQUAL the miss's — a hit/miss
    // accounting asymmetry (e.g. hits counting tokens the miss convention
    // skips) would break this exact-delta check.
    expect(afterHit.tokens - afterMiss.tokens).toBe(afterMiss.tokens);
  });

  test('lookup-embed failure: consult degrades to disabled — recorded once, neither counter', async () => {
    embedBehavior = async () => { throw new Error('embed provider down'); };
    // The failed consult must not break the search: keyword fallback serves.
    const results = await hybridSearchCached(engine, 'bob cache wiring', { limit: 5 });
    expect(results.length).toBeGreaterThan(0);

    const counters = await readCounters();
    expect(counters.c).toBe(1);
    expect(counters.hit).toBe(0);
    expect(counters.miss).toBe(0);
    expect(counters.rank1).toBe(1);
  });

  test('consult skipped (useCache:false): recorded once, neither counter', async () => {
    const results = await hybridSearchCached(engine, 'bob cache wiring', { limit: 5, useCache: false });
    expect(results.length).toBeGreaterThan(0);

    const counters = await readCounters();
    expect(counters.c).toBe(1);
    expect(counters.hit).toBe(0);
    expect(counters.miss).toBe(0);
    // Telemetry otherwise unchanged: the search still counts fully.
    expect(counters.rank1).toBe(1);
    expect(counters.results).toBeGreaterThan(0);
  });
});

describe('bare hybridSearch — direct callers unchanged', () => {
  test('records once with no cache classification', async () => {
    let meta: import('../src/core/types.ts').HybridSearchMeta | undefined;
    const results = await hybridSearch(engine, 'bob cache wiring', {
      limit: 5,
      onMeta: (m) => { meta = m; },
    });
    expect(results.length).toBeGreaterThan(0);
    // The onMeta contract is untouched: no cache field is injected into the
    // caller-visible meta (the fold happens on the recorded copy only).
    expect(meta?.cache).toBeUndefined();

    const counters = await readCounters();
    expect(counters.c).toBe(1);
    expect(counters.hit).toBe(0);
    expect(counters.miss).toBe(0);
  });
});
