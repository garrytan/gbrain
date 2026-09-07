/**
 * Production-wrapper regression coverage with semantic response caching disabled.
 * Fresh reads must retain filtering, metadata and telemetry guarantees; legacy
 * cache implementation behavior is covered by the direct cache-class suites.
 * Serial because embedding and gateway configuration are process-global.
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
  await engine.setConfig('search.reranker.enabled', 'false');

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

describe('meta-key parity between bare and repeated wrapper reads', () => {
  test('repeated wrapper reads carry every key bare hybridSearch emits', async () => {
    let bareMeta: HybridSearchMeta | undefined;
    await hybridSearch(engine, 'builder', { limit: 5, onMeta: (m) => { bareMeta = m; } });
    const bareKeys = Object.keys(bareMeta!);
    expect(bareKeys).toContain('degraded');
    expect(bareKeys).toContain('retrieved_count');

    const { meta: firstMeta } = await cachedRun('builder', { limit: 5 });
    expect(firstMeta.cache?.status).toBe('disabled');
    for (const k of bareKeys) {
      expect(Object.keys(firstMeta)).toContain(k);
    }

    await awaitPendingSearchCacheWrites();

    const { meta: repeatMeta } = await cachedRun('builder', { limit: 5 });
    expect(repeatMeta.cache?.status).toBe('disabled');
    for (const k of bareKeys) {
      expect(Object.keys(repeatMeta)).toContain(k);
    }
  });
});

describe('fresh wrapper metadata', () => {
  test('repeated fresh reads report disabled caching and clean degradation metadata', async () => {
    const { meta: firstMeta } = await cachedRun('builder', { limit: 5 });
    expect(firstMeta.degraded).toEqual([]);
    await awaitPendingSearchCacheWrites();

    const { meta: repeatMeta } = await cachedRun('builder', { limit: 5 });
    expect(repeatMeta.cache?.status).toBe('disabled');
    expect(repeatMeta.degraded).toEqual([]); // stored stamp, not cache_prestamp
    expect(typeof repeatMeta.retrieved_count).toBe('number');
  });

  test('positive offsets remain uncached with retrieval metadata', async () => {
    const { results: missResults } = await cachedRun('builder', { limit: 5 });
    expect(missResults.length).toBeGreaterThan(0);
    await awaitPendingSearchCacheWrites();

    const { meta } = await cachedRun('builder', { limit: 5, offset: 50 });
    expect(meta.cache?.status).toBe('disabled');
    expect(typeof meta.retrieved_count).toBe('number');
  });

  test('negative offsets remain uncached with retrieval metadata', async () => {
    const { results: missResults } = await cachedRun('builder', { limit: 5 });
    expect(missResults.length).toBeGreaterThan(0);
    await awaitPendingSearchCacheWrites();

    const { meta } = await cachedRun('builder', { limit: 5, offset: -50 });
    expect(meta.cache?.status).toBe('disabled');
    expect(typeof meta.retrieved_count).toBe('number');
  });
});

describe('legacy metadata is never restored into a fresh response', () => {
  test('legacy metadata lacking the degradation stamp cannot affect a fresh response', async () => {
    const first = await cachedRun('builder', { limit: 5 });
    expect(first.results.length).toBeGreaterThan(0);
    const { degraded: _degraded, ...legacyMeta } = first.meta;
    await new SemanticQueryCache(engine).store('builder', fixedEmbedding(), first.results, legacyMeta);
    expect(await engine.executeRaw('SELECT id FROM query_cache')).toHaveLength(1);

    const { meta } = await cachedRun('builder', { limit: 5 });
    expect(meta.cache?.status).toBe('disabled');
    expect(meta.degraded).toEqual([]);
    expect(meta.retrieved_count).toBe(first.meta.retrieved_count);
  });
});

describe('clean and degraded result sets both bypass cache writes', () => {
  test('expansion degradation is reported without writing a cache row', async () => {
    const { meta } = await cachedRun('builder', {
      limit: 5,
      expansion: true,
      expandFn: async () => ['builder', 'EMBEDFAIL variant'],
    });
    expect(meta.cache?.status).toBe('disabled');
    expect((meta.degraded ?? []).map((d) => d.stage)).toContain('expansion_partial');
    await awaitPendingSearchCacheWrites();

    const rows = await engine.executeRaw<{ ttl_seconds: number; meta: unknown }>(
      'SELECT ttl_seconds, meta FROM query_cache',
    );
    expect(rows).toHaveLength(0);
  });

  test('clean runs also leave the cache empty', async () => {
    await cachedRun('builder', { limit: 5 });
    await awaitPendingSearchCacheWrites();
    const rows = await engine.executeRaw<{ ttl_seconds: number }>(
      'SELECT ttl_seconds FROM query_cache',
    );
    expect(rows).toHaveLength(0);
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
