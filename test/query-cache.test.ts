/**
 * v0.32.x search-lite \u2014 semantic query cache.
 *
 * PGLite-backed test. Confirms:
 *   - migration v51 creates the query_cache table
 *   - store + lookup roundtrip with EXACT same embedding \u2192 hit
 *   - lookup with a similar embedding (cosine > 0.92) \u2192 hit
 *   - lookup with a far embedding \u2192 miss
 *   - TTL expiration: a stale row is skipped at read time
 *   - clear / prune / stats work as advertised
 *   - source_id isolation: brain A's cache doesn't leak to brain B
 *   - disabled cache is a pure no-op
 *
 * Uses synthetic Float32Array embeddings so the test doesn't depend on
 * any external embedding provider.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { SemanticQueryCache, cacheRowId } from '../src/core/search/query-cache.ts';
import type { SearchResult, HybridSearchMeta } from '../src/core/types.ts';

let engine: PGLiteEngine;

// Build a stable, normalized embedding. PGLite ships pgvector with 1536-dim
// support (the default); a smaller test dim won't match the column. We
// truncate / pad to 1536 to match the migration's resolved dim.
const DIM = 1536;

function makeEmbedding(seed: number, dim = DIM): Float32Array {
  const e = new Float32Array(dim);
  // Simple deterministic generator with a unique fingerprint per seed
  // so similar seeds produce similar (cosine > 0.95) vectors and distinct
  // seeds produce orthogonal-ish ones.
  for (let i = 0; i < dim; i++) {
    e[i] = Math.sin(seed * 0.001 + i * 0.01);
  }
  // L2-normalize so cosine = dot product.
  let mag = 0;
  for (let i = 0; i < dim; i++) mag += e[i] * e[i];
  mag = Math.sqrt(mag);
  if (mag > 0) for (let i = 0; i < dim; i++) e[i] /= mag;
  return e;
}

function makeOrthogonalEmbedding(seed: number, dim = DIM): Float32Array {
  // Use a totally different basis so cosine is near-zero.
  const e = new Float32Array(dim);
  for (let i = 0; i < dim; i++) {
    e[i] = Math.cos(seed * 13.7 + i * 0.97);
  }
  let mag = 0;
  for (let i = 0; i < dim; i++) mag += e[i] * e[i];
  mag = Math.sqrt(mag);
  if (mag > 0) for (let i = 0; i < dim; i++) e[i] /= mag;
  return e;
}

function makeResult(slug: string): SearchResult {
  return {
    slug,
    page_id: 1,
    title: `Title for ${slug}`,
    type: 'concept',
    chunk_text: `chunk text for ${slug}`,
    chunk_source: 'compiled_truth',
    chunk_id: 1,
    chunk_index: 0,
    score: 1.0,
    stale: false,
  };
}

const META: HybridSearchMeta = {
  vector_enabled: true,
  detail_resolved: 'medium',
  expansion_applied: false,
  intent: 'general',
};

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  try { await engine.disconnect(); } catch { /* ignore */ }
});

beforeEach(async () => {
  // Wipe the cache between tests so ordering doesn't matter.
  await engine.executeRaw(`DELETE FROM query_cache`);
});

describe('migration v51 \u2014 query_cache table exists', () => {
  test('table is present and has expected columns', async () => {
    const rows = await engine.executeRaw<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'query_cache'`,
    );
    const names = rows.map(r => r.column_name);
    expect(names).toContain('id');
    expect(names).toContain('query_text');
    expect(names).toContain('source_id');
    expect(names).toContain('embedding');
    expect(names).toContain('results');
    expect(names).toContain('meta');
    expect(names).toContain('ttl_seconds');
    expect(names).toContain('created_at');
    expect(names).toContain('hit_count');
  });
});

describe('cacheRowId', () => {
  test('is deterministic across same input', () => {
    expect(cacheRowId('hello', 'default')).toBe(cacheRowId('hello', 'default'));
  });
  test('differs across source_id', () => {
    expect(cacheRowId('hello', 'a')).not.toBe(cacheRowId('hello', 'b'));
  });
});

describe('SemanticQueryCache \u2014 store + lookup', () => {
  test('roundtrip: exact embedding match returns a hit', async () => {
    const cache = new SemanticQueryCache(engine);
    const emb = makeEmbedding(1);
    const results = [makeResult('a'), makeResult('b')];

    await cache.store('what is foo', emb, results, META);
    const hit = await cache.lookup(emb);

    expect(hit.hit).toBe(true);
    expect(hit.results).toHaveLength(2);
    expect(hit.results?.[0].slug).toBe('a');
    expect(hit.similarity).toBeGreaterThan(0.99);
  });

  test('similar embedding (cosine > 0.92) is a hit', async () => {
    const cache = new SemanticQueryCache(engine);
    const base = makeEmbedding(100);

    // Construct a near-neighbor: tweak a few dims so cosine stays > 0.92.
    const near = new Float32Array(base);
    for (let i = 0; i < 10; i++) near[i] += 0.005;
    // Re-normalize.
    let mag = 0;
    for (let i = 0; i < DIM; i++) mag += near[i] * near[i];
    mag = Math.sqrt(mag);
    for (let i = 0; i < DIM; i++) near[i] /= mag;

    await cache.store('what is foo', base, [makeResult('a')], META);
    const hit = await cache.lookup(near);

    expect(hit.hit).toBe(true);
    expect(hit.similarity).toBeGreaterThan(0.92);
  });

  test('orthogonal embedding is a miss', async () => {
    const cache = new SemanticQueryCache(engine);
    const a = makeEmbedding(1);
    const b = makeOrthogonalEmbedding(2);
    await cache.store('q1', a, [makeResult('a')], META);
    const hit = await cache.lookup(b);
    expect(hit.hit).toBe(false);
  });
});

describe('SemanticQueryCache \u2014 TTL', () => {
  test('stale row (past TTL) is not returned', async () => {
    const cache = new SemanticQueryCache(engine, { ttlSeconds: 1 });
    const emb = makeEmbedding(42);
    await cache.store('q', emb, [makeResult('a')], META, { ttlSeconds: 1 });

    // Manually rewind created_at to simulate expiration.
    await engine.executeRaw(
      `UPDATE query_cache SET created_at = now() - interval '10 seconds'`,
    );
    const hit = await cache.lookup(emb);
    expect(hit.hit).toBe(false);
  });
});

describe('SemanticQueryCache \u2014 source isolation', () => {
  test('different source_id cannot read each other\u2019s rows', async () => {
    const cache = new SemanticQueryCache(engine);
    const emb = makeEmbedding(7);
    await cache.store('q', emb, [makeResult('a')], META, { sourceId: 'src-A' });
    const hitB = await cache.lookup(emb, { sourceId: 'src-B' });
    expect(hitB.hit).toBe(false);
    const hitA = await cache.lookup(emb, { sourceId: 'src-A' });
    expect(hitA.hit).toBe(true);
  });
});

describe('SemanticQueryCache \u2014 management', () => {
  test('clear() wipes all rows', async () => {
    const cache = new SemanticQueryCache(engine);
    const emb = makeEmbedding(9);
    await cache.store('q1', emb, [makeResult('a')], META);
    await cache.store('q2', makeEmbedding(10), [makeResult('b')], META);
    const removed = await cache.clear();
    expect(removed).toBeGreaterThanOrEqual(2);
    const stats = await cache.stats();
    expect(stats.total_rows).toBe(0);
  });

  test('prune() deletes only stale rows', async () => {
    const cache = new SemanticQueryCache(engine);
    await cache.store('fresh', makeEmbedding(11), [makeResult('a')], META);
    await cache.store('stale', makeEmbedding(12), [makeResult('b')], META, { ttlSeconds: 1 });
    await engine.executeRaw(
      `UPDATE query_cache SET created_at = now() - interval '10 seconds' WHERE query_text = 'stale'`,
    );
    const removed = await cache.prune();
    expect(removed).toBe(1);
    const stats = await cache.stats();
    expect(stats.total_rows).toBe(1);
    expect(stats.fresh_rows).toBe(1);
  });

  test('stats() reports fresh / stale / total / hit counters', async () => {
    const cache = new SemanticQueryCache(engine);
    const emb = makeEmbedding(13);
    await cache.store('q', emb, [makeResult('a')], META);
    await cache.lookup(emb);  // bump hit
    // Hit bump is async/fire-and-forget; give it a moment to land.
    await new Promise(r => setTimeout(r, 50));
    const stats = await cache.stats();
    expect(stats.total_rows).toBe(1);
    expect(stats.fresh_rows).toBe(1);
    expect(stats.stale_rows).toBe(0);
    expect(stats.total_hits).toBeGreaterThanOrEqual(1);
  });
});

describe('SemanticQueryCache \u2014 disabled', () => {
  test('disabled cache is a pure no-op on lookup', async () => {
    const cache = new SemanticQueryCache(engine, { enabled: false });
    const emb = makeEmbedding(99);
    await cache.store('q', emb, [makeResult('a')], META);
    // Even after a store call, lookup must miss because enabled=false.
    const hit = await cache.lookup(emb);
    expect(hit.hit).toBe(false);
  });
});
