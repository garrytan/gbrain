/**
 * Regression test for [CDX-4] cross-mode cache contamination.
 *
 * Before v0.32.3 (PR #897 as merged), the query_cache primary key was
 * sha256(source_id::query_text) — a tokenmax search (expansion=on, limit=50)
 * would populate a row that a subsequent conservative call (no expansion,
 * limit=10) read back, serving the wrong-shape results.
 *
 * After v0.32.3:
 *   - cacheRowId(query, source, knobsHash) — knobsHash is part of the PK
 *   - SemanticQueryCache.lookup({knobsHash}) filters WHERE knobs_hash = $
 *   - SemanticQueryCache.store({knobsHash}) writes the resolved hash
 *
 * This test exercises the cache class directly on a fresh PGLite brain
 * to verify cross-mode writes don't collide.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { SemanticQueryCache, cacheRowId } from '../src/core/search/query-cache.ts';
import type { SearchResult } from '../src/core/types.ts';
import { knobsHash, resolveSearchMode } from '../src/core/search/mode.ts';

let engine: PGLiteEngine;

const conservativeHash = knobsHash(resolveSearchMode({ mode: 'conservative' }));
const balancedHash = knobsHash(resolveSearchMode({ mode: 'balanced' }));
const tokenmaxHash = knobsHash(resolveSearchMode({ mode: 'tokenmax' }));

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  // Clear cache before each test so writes start from empty state.
  await engine.executeRaw('DELETE FROM query_cache');
});

const makeEmbedding = (seed: number): Float32Array => {
  const arr = new Float32Array(1536);
  for (let i = 0; i < 1536; i++) {
    arr[i] = Math.sin(seed + i * 0.001);
  }
  // Normalize to unit length so cosine similarity is well-defined.
  let norm = 0;
  for (let i = 0; i < 1536; i++) norm += arr[i] * arr[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < 1536; i++) arr[i] /= norm;
  return arr;
};

const makeResults = (label: string, n: number): SearchResult[] =>
  Array.from({ length: n }, (_, i) => ({
    slug: `${label}/result-${i}`,
    title: `${label} result ${i}`,
    chunk_text: `chunk-${label}-${i}`,
    chunk_id: (i + 1) * 1000,
    score: 1 / (i + 1),
    chunk_index: i,
    type: 'note' as const,
    chunk_source: 'compiled_truth' as const,
    page_id: i + 1,
    stale: false,
  }));

describe('cacheRowId is bifurcated by knobsHash', () => {
  test('same (query, source) but different knobs → different row IDs', () => {
    const id1 = cacheRowId('what is the meaning of life', 'default', conservativeHash);
    const id2 = cacheRowId('what is the meaning of life', 'default', tokenmaxHash);
    expect(id1).not.toBe(id2);
  });

  test('same (query, source, knobs) → same row ID (idempotent)', () => {
    const id1 = cacheRowId('what is the meaning of life', 'default', balancedHash);
    const id2 = cacheRowId('what is the meaning of life', 'default', balancedHash);
    expect(id1).toBe(id2);
  });

  test('empty knobsHash still produces a valid ID (test-fixture compatibility)', () => {
    const id = cacheRowId('q', 'default', '');
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });

  test('all three mode hashes are distinct', () => {
    expect(conservativeHash).not.toBe(balancedHash);
    expect(balancedHash).not.toBe(tokenmaxHash);
    expect(conservativeHash).not.toBe(tokenmaxHash);
  });
});

describe('SemanticQueryCache cross-mode isolation (CDX-4 hotfix)', () => {
  test('tokenmax write does NOT contaminate conservative lookup', async () => {
    const cache = new SemanticQueryCache(engine);
    const emb = makeEmbedding(1);
    const tokenmaxResults = makeResults('tokenmax', 50);

    // Write under tokenmax knobs.
    await cache.store('what is the meaning of life', emb, tokenmaxResults, {
      vector_enabled: true,
      detail_resolved: null,
      expansion_applied: true,
    }, { knobsHash: tokenmaxHash });

    // Lookup under conservative knobs with the same embedding → MISS.
    const conservativeHit = await cache.lookup(emb, { knobsHash: conservativeHash });
    expect(conservativeHit.hit).toBe(false);

    // Lookup under tokenmax knobs with the same embedding → HIT.
    const tokenmaxHit = await cache.lookup(emb, { knobsHash: tokenmaxHash });
    expect(tokenmaxHit.hit).toBe(true);
    expect(tokenmaxHit.results?.length).toBe(50);
    expect(tokenmaxHit.results?.[0].slug).toBe('tokenmax/result-0');
  });

  test('three modes coexist as distinct rows for the same query', async () => {
    const cache = new SemanticQueryCache(engine);
    const emb = makeEmbedding(2);

    await cache.store('q', emb, makeResults('conservative', 10), {
      vector_enabled: true, detail_resolved: null, expansion_applied: false,
    }, { knobsHash: conservativeHash });
    await cache.store('q', emb, makeResults('balanced', 25), {
      vector_enabled: true, detail_resolved: null, expansion_applied: false,
    }, { knobsHash: balancedHash });
    await cache.store('q', emb, makeResults('tokenmax', 50), {
      vector_enabled: true, detail_resolved: null, expansion_applied: true,
    }, { knobsHash: tokenmaxHash });

    const rows = await engine.executeRaw<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM query_cache WHERE query_text = 'q'`,
    );
    expect(rows[0].n).toBe(3);

    const cHit = await cache.lookup(emb, { knobsHash: conservativeHash });
    expect(cHit.hit).toBe(true);
    expect(cHit.results?.length).toBe(10);
    expect(cHit.results?.[0].slug).toBe('conservative/result-0');

    const bHit = await cache.lookup(emb, { knobsHash: balancedHash });
    expect(bHit.hit).toBe(true);
    expect(bHit.results?.length).toBe(25);

    const tHit = await cache.lookup(emb, { knobsHash: tokenmaxHash });
    expect(tHit.hit).toBe(true);
    expect(tHit.results?.length).toBe(50);
  });

  test('legacy rows (NULL knobs_hash) are excluded from lookup', async () => {
    // Manually insert a row with NULL knobs_hash (simulating pre-v0.32.3 state).
    const emb = makeEmbedding(3);
    const vecStr = `[${Array.from(emb).map(v => v.toFixed(6)).join(',')}]`;
    await engine.executeRaw(
      `INSERT INTO query_cache (id, query_text, source_id, knobs_hash, embedding, results, meta, ttl_seconds, created_at)
       VALUES ($1, $2, $3, NULL, $4::vector, $5::jsonb, $6::jsonb, 3600, now())`,
      [
        'legacy-row-id',
        'legacy-query',
        'default',
        vecStr,
        JSON.stringify(makeResults('legacy', 5)),
        JSON.stringify({ vector_enabled: true, detail_resolved: null, expansion_applied: false }),
      ],
    );

    const cache = new SemanticQueryCache(engine);
    // Any mode's lookup → MISS (NULL row is excluded by the knobs_hash filter).
    expect((await cache.lookup(emb, { knobsHash: conservativeHash })).hit).toBe(false);
    expect((await cache.lookup(emb, { knobsHash: balancedHash })).hit).toBe(false);
    expect((await cache.lookup(emb, { knobsHash: tokenmaxHash })).hit).toBe(false);
  });

  test('same mode written twice updates in place (no duplicate rows)', async () => {
    const cache = new SemanticQueryCache(engine);
    const emb = makeEmbedding(4);

    await cache.store('q', emb, makeResults('first', 5), {
      vector_enabled: true, detail_resolved: null, expansion_applied: false,
    }, { knobsHash: balancedHash });

    await cache.store('q', emb, makeResults('second', 7), {
      vector_enabled: true, detail_resolved: null, expansion_applied: false,
    }, { knobsHash: balancedHash });

    const rows = await engine.executeRaw<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM query_cache WHERE query_text = 'q'`,
    );
    expect(rows[0].n).toBe(1);

    const hit = await cache.lookup(emb, { knobsHash: balancedHash });
    expect(hit.hit).toBe(true);
    expect(hit.results?.length).toBe(7);
    expect(hit.results?.[0].slug).toBe('second/result-0');
  });

  test('empty knobsHash arg writes a row but does not collide with mode-hash rows', async () => {
    const cache = new SemanticQueryCache(engine);
    const emb = makeEmbedding(5);

    await cache.store('q', emb, makeResults('no-mode', 3), {
      vector_enabled: true, detail_resolved: null, expansion_applied: false,
    });

    // No-mode lookup hits its own row.
    const noModeHit = await cache.lookup(emb);
    expect(noModeHit.hit).toBe(true);
    expect(noModeHit.results?.length).toBe(3);

    // Conservative-hash lookup misses (the no-mode row had empty hash).
    const conservativeHit = await cache.lookup(emb, { knobsHash: conservativeHash });
    expect(conservativeHit.hit).toBe(false);
  });
});
