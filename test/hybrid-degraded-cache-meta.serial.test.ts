/**
 * WP2/T3 — cached-wrapper meta correctness (ENG-5 + D14.2 + cache_prestamp).
 *
 * Drives real store→hit roundtrips (mocked `embedQuery` for a deterministic
 * vector, real PGLite SemanticQueryCache) and pins:
 *
 *   - meta-key-parity: bare hybridSearch's meta keys ⊆ cached wrapper's,
 *     on BOTH the miss and the hit path (the spread-carry rebuild can
 *     never silently drop a key again — the adaptive_return drop class)
 *   - cache-hit stamping: `cache.status === 'hit'`, degraded carried from
 *     the stored row; hit-with-offset stays labeled 'hit'
 *   - cache_prestamp: a row whose stored meta lacks the degradation stamp
 *     surfaces degraded:[{stage:'cache_prestamp'}], never a clean claim
 *   - D14.2 short TTL: a degraded (but embeddable) result set is written
 *     with ttl_seconds=60; a clean set keeps the resolved TTL (3600)
 *   - null-embedding store is a silent no-op (ENG-6 — total embed outage
 *     is uncacheable by construction)
 *
 * Serial: mock.module + gateway/global-env mutation (isolation guard R2).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
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
// EMBEDFAIL markers only fail the INNER variant embeds — the cache-consult
// embed uses the original query text.
mock.module('../src/core/embedding.ts', () => ({
  ...realEmbedding,
  embed: async () => fixedEmbedding(),
  embedQuery: async (text: string) => {
    if (String(text).includes('EMBEDFAIL')) throw new Error('mock embed provider failure');
    return fixedEmbedding();
  },
}));

// Import AFTER mocking.
const {
  hybridSearch,
  hybridSearchCached,
  awaitPendingSearchCacheWrites,
  DEGRADED_CACHE_TTL_SECONDS,
} = await import('../src/core/search/hybrid.ts');
const { SemanticQueryCache } = await import('../src/core/search/query-cache.ts');
const { configureGateway, resetGateway } = await import('../src/core/ai/gateway.ts');
const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');

let engine: InstanceType<typeof PGLiteEngine>;
let tmpHome: string;
const savedGbrainHome = process.env.GBRAIN_HOME;

beforeAll(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-degraded-cache-meta-'));
  process.env.GBRAIN_HOME = tmpHome;

  resetGateway();
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    env: { OPENAI_API_KEY: 'sk-fake' },
  });

  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  const fixtures: Array<[string, string, string]> = [
    ['alice-foo', 'Alice Foo', 'person'],
    ['bob-bar', 'Bob Bar', 'company'],
    ['carol-baz', 'Carol Baz', 'note'],
  ];
  for (const [slug, title, type] of fixtures) {
    const truth = `${title} is a builder shipping cache meta.`;
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
  // Every query shares the same mocked vector, so rows from one test would
  // HIT for another test's different query text. Isolate per test.
  await engine.executeRaw('DELETE FROM query_cache');
});

async function cachedRun(
  query: string,
  opts: Parameters<typeof hybridSearchCached>[2] = {},
): Promise<{ results: SearchResult[]; meta: HybridSearchMeta }> {
  let meta: HybridSearchMeta | undefined;
  const results = await hybridSearchCached(engine, query, {
    ...opts,
    onMeta: (m) => { meta = m; },
  });
  if (!meta) throw new Error('onMeta never fired');
  return { results, meta };
}

describe('meta-key-parity (ENG-5) — bare keys ⊆ cached keys, hit and miss', () => {
  test('miss and hit both carry every key bare hybridSearch emits', async () => {
    let bareMeta: HybridSearchMeta | undefined;
    await hybridSearch(engine, 'builder', { limit: 5, onMeta: (m) => { bareMeta = m; } });
    const bareKeys = Object.keys(bareMeta!);
    expect(bareKeys).toContain('degraded');
    expect(bareKeys).toContain('retrieved_count');

    const { meta: missMeta } = await cachedRun('builder', { limit: 5 });
    expect(missMeta.cache?.status).toBe('miss');
    for (const k of bareKeys) {
      expect(Object.keys(missMeta)).toContain(k);
    }

    await awaitPendingSearchCacheWrites();

    const { meta: hitMeta } = await cachedRun('builder', { limit: 5 });
    expect(hitMeta.cache?.status).toBe('hit');
    for (const k of bareKeys) {
      expect(Object.keys(hitMeta)).toContain(k);
    }
  });
});

describe('cache-hit stamping', () => {
  test('hit carries cache.status=hit + the stored (clean) degradation stamp', async () => {
    const { meta: missMeta } = await cachedRun('builder', { limit: 5 });
    expect(missMeta.degraded).toEqual([]);
    await awaitPendingSearchCacheWrites();

    const { meta: hitMeta } = await cachedRun('builder', { limit: 5 });
    expect(hitMeta.cache?.status).toBe('hit');
    expect(hitMeta.degraded).toEqual([]); // stored stamp, not cache_prestamp
    expect(typeof hitMeta.retrieved_count).toBe('number');
  });

  test('offset>0 bypasses the cache entirely (pages are cache-hostile until the pre-slice pool is stored)', async () => {
    // Post-#3002/#3871 hardening: the cache stores the already-sliced page,
    // so serving ANY offset against it returns wrong/empty rows. Paged
    // requests skip both lookup and store — status 'disabled', engine-served.
    const { results: missResults } = await cachedRun('builder', { limit: 5 });
    expect(missResults.length).toBeGreaterThan(0);
    await awaitPendingSearchCacheWrites();

    const { meta } = await cachedRun('builder', { limit: 5, offset: 50 });
    expect(meta.cache?.status).toBe('disabled');
    expect(typeof meta.retrieved_count).toBe('number');
  });

  test('offset<0 also bypasses the cache entirely (#4358 residual — negative offsets re-slice a stored page just as badly as positive ones)', async () => {
    const { results: missResults } = await cachedRun('builder', { limit: 5 });
    expect(missResults.length).toBeGreaterThan(0);
    await awaitPendingSearchCacheWrites();

    const { meta } = await cachedRun('builder', { limit: 5, offset: -50 });
    expect(meta.cache?.status).toBe('disabled');
    expect(typeof meta.retrieved_count).toBe('number');
  });
});

describe('cache_prestamp — pre-upgrade rows cannot claim clean', () => {
  test('stored meta lacking the degraded key surfaces cache_prestamp on hit', async () => {
    await cachedRun('builder', { limit: 5 });
    await awaitPendingSearchCacheWrites();
    // Simulate a pre-stamp row: strip the degraded key from the stored meta.
    await engine.executeRaw(`UPDATE query_cache SET meta = meta - 'degraded'`);

    const { meta } = await cachedRun('builder', { limit: 5 });
    expect(meta.cache?.status).toBe('hit');
    expect(meta.degraded).toEqual([{ stage: 'cache_prestamp' }]);
  });
});

describe('D14.2 — degraded result sets get a short-TTL cache entry', () => {
  test('embeddable degradation (expansion_partial) writes ttl_seconds=60, stamped', async () => {
    const { meta } = await cachedRun('builder', {
      limit: 5,
      expansion: true,
      expandFn: async () => ['builder', 'EMBEDFAIL variant'],
    });
    expect(meta.cache?.status).toBe('miss');
    expect((meta.degraded ?? []).map((d) => d.stage)).toContain('expansion_partial');
    await awaitPendingSearchCacheWrites();

    const rows = await engine.executeRaw<{ ttl_seconds: number; meta: unknown }>(
      'SELECT ttl_seconds, meta FROM query_cache',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].ttl_seconds).toBe(DEGRADED_CACHE_TTL_SECONDS);
    const storedMeta = rows[0].meta as HybridSearchMeta;
    expect((storedMeta.degraded ?? []).map((d) => d.stage)).toContain('expansion_partial');
  });

  test('clean run keeps the resolved TTL (3600 default)', async () => {
    await cachedRun('builder', { limit: 5 });
    await awaitPendingSearchCacheWrites();
    const rows = await engine.executeRaw<{ ttl_seconds: number }>(
      'SELECT ttl_seconds FROM query_cache',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].ttl_seconds).toBe(3600);
  });
});

describe('ENG-6 — null-embedding store stays a silent no-op', () => {
  test('store(null embedding) writes nothing and never throws', async () => {
    const cache = new SemanticQueryCache(engine);
    const result: SearchResult = {
      slug: 'alice-foo',
      page_id: 1,
      title: 'Alice Foo',
      type: 'person',
      chunk_text: 'Alice Foo is a builder.',
      chunk_source: 'compiled_truth',
      chunk_id: 1,
      chunk_index: 0,
      score: 1.0,
      stale: false,
    };
    const meta: HybridSearchMeta = {
      vector_enabled: false,
      detail_resolved: null,
      expansion_applied: false,
      degraded: [{ stage: 'embed_unavailable', reason: 'provider_error' }],
      retrieved_count: 1,
    };
    await cache.store('outage query', null, [result], meta);
    const rows = await engine.executeRaw<{ n: number }>(
      'SELECT COUNT(*)::int AS n FROM query_cache',
    );
    expect(rows[0].n).toBe(0);
  });
});
