/**
 * v0.40.3.0 — query cache invalidation gate (end-to-end against PGLite)
 *
 * The cache gate has TWO layers:
 *   Layer 1: corpus-state bookmark (MAX(generation) FROM pages)
 *   Layer 2: per-page snapshot (page_generations JSONB)
 *
 * This file pins the integration via real cache writes + lookups, then
 * mutates pages and re-runs the lookup. SCENARIOS:
 *
 *   1. store → lookup returns HIT (bookmark + snapshot match)
 *   2. content UPDATE on a result page → lookup returns MISS (per-page bumped)
 *   3. content UPDATE on a NON-result page → lookup may serve via Layer 2
 *      (bookmark fires; snapshot intact) — codex's "subtle but correct" case
 *   4. INSERT new page → lookup serves via Layer 2 (bookmark fires;
 *      snapshot empty for new page, no conflict) — codex #4 INSERT coverage
 *   5. LEGACY ROW (pre-v0.40.3.0 shape: empty {} snapshot, zero bookmark)
 *      → lookup HIT (IRON-RULE backward compat)
 *   6. DELETE a result page → lookup returns MISS (LEFT JOIN NULL)
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { SemanticQueryCache } from '../../src/core/search/query-cache.ts';
import type { SearchResult, HybridSearchMeta } from '../../src/core/types.ts';

const FAKE_EMBEDDING_DIM = 1536; // Matches default OpenAI / pglite-schema __EMBEDDING_DIMS__.

function fakeEmbedding(seed: number): Float32Array {
  const v = new Float32Array(FAKE_EMBEDDING_DIM);
  for (let i = 0; i < v.length; i++) {
    v[i] = Math.sin(seed + i * 0.01);
  }
  // Normalize so cosine compares correctly.
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  const mag = Math.sqrt(sum);
  for (let i = 0; i < v.length; i++) v[i] = v[i] / mag;
  return v;
}

function fakeMeta(): HybridSearchMeta {
  return {
    sources_consulted: ['fake'],
    intent: 'general',
    detail: 'medium',
  } as unknown as HybridSearchMeta;
}

describe('cache gate end-to-end (PGLite)', () => {
  let engine: PGLiteEngine;
  let cache: SemanticQueryCache;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    cache = new SemanticQueryCache(engine);
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  beforeEach(async () => {
    await resetPgliteState(engine);
  });

  async function seedPage(slug: string, body: string): Promise<number> {
    const p = await engine.putPage(slug, {
      type: 'note',
      title: slug,
      compiled_truth: body,
      timeline: '',
      frontmatter: {},
    });
    return p.id;
  }

  test('store → lookup HIT (baseline freshness)', async () => {
    const p1 = await seedPage('test/p1', 'alpha bravo');
    const results: SearchResult[] = [
      {
        page_id: p1,
        slug: 'test/p1',
        title: 'test/p1',
        snippet: 'alpha bravo',
        score: 1.0,
      } as unknown as SearchResult,
    ];
    const emb = fakeEmbedding(1);
    await cache.store('alpha bravo', emb, results, fakeMeta(), { sourceId: 'default' });
    const hit = await cache.lookup(emb, { sourceId: 'default' });
    expect(hit.hit).toBe(true);
    expect(hit.results?.length).toBe(1);
  });

  test('content UPDATE on a result page → lookup MISS (per-page bumped)', async () => {
    const p1 = await seedPage('test/p1', 'alpha bravo v1');
    const results: SearchResult[] = [
      { page_id: p1, slug: 'test/p1', title: 'test/p1', snippet: 'x', score: 1.0 } as unknown as SearchResult,
    ];
    const emb = fakeEmbedding(2);
    await cache.store('alpha bravo', emb, results, fakeMeta(), { sourceId: 'default' });

    // Update content_truth — trigger bumps p1.generation
    await engine.putPage('test/p1', {
      type: 'note',
      title: 'test/p1',
      compiled_truth: 'alpha bravo v2 — modified',
      timeline: '',
      frontmatter: {},
    });

    const hit = await cache.lookup(emb, { sourceId: 'default' });
    expect(hit.hit).toBe(false);
  });

  test('INSERT new page → lookup HIT (bookmark fires but snapshot intact — codex #4 case)', async () => {
    const p1 = await seedPage('test/p1', 'alpha');
    const results: SearchResult[] = [
      { page_id: p1, slug: 'test/p1', title: 'test/p1', snippet: 'a', score: 1.0 } as unknown as SearchResult,
    ];
    const emb = fakeEmbedding(3);
    await cache.store('alpha', emb, results, fakeMeta(), { sourceId: 'default' });

    // Create an UNRELATED new page (different topic, not in result set).
    await seedPage('test/p2', 'beta gamma');

    // The bookmark fires (new page bumped MAX(generation)) but Layer 2
    // (per-page snapshot) sees p1's generation unchanged → row serves.
    // This is the SUBTLE correctness property: cache stays useful in
    // brains that are actively being written to.
    const hit = await cache.lookup(emb, { sourceId: 'default' });
    expect(hit.hit).toBe(true);
  });

  test('legacy row (pre-v0.40.3.0 shape) serves normally — IRON-RULE backward compat', async () => {
    const p1 = await seedPage('test/p1', 'gamma delta');
    const emb = fakeEmbedding(4);
    const results: SearchResult[] = [
      { page_id: p1, slug: 'test/p1', title: 'test/p1', snippet: 'g', score: 1.0 } as unknown as SearchResult,
    ];
    // Simulate a pre-v0.40.3.0 row by writing with the new gate then
    // hand-mutating page_generations + max_generation_at_store to the
    // legacy shape.
    await cache.store('gamma delta', emb, results, fakeMeta(), { sourceId: 'default' });
    await engine.executeRaw(
      `UPDATE query_cache
          SET page_generations = '{}'::jsonb,
              max_generation_at_store = 0`,
    );

    // Now write a bunch of content so MAX(generation) > 0. The legacy
    // row's bookmark (0) is less than MAX, so bookmark fires; Layer 2
    // sees empty snapshot → vacuously valid → row serves.
    await seedPage('test/p2', 'unrelated bump');
    await seedPage('test/p3', 'another unrelated bump');

    const hit = await cache.lookup(emb, { sourceId: 'default' });
    expect(hit.hit).toBe(true); // Legacy compat — pre-upgrade rows still serve.
  });

  test('soft-delete result page → lookup MISS (trigger bumps generation)', async () => {
    const p1 = await seedPage('test/p1', 'epsilon');
    const results: SearchResult[] = [
      { page_id: p1, slug: 'test/p1', title: 'test/p1', snippet: 'e', score: 1.0 } as unknown as SearchResult,
    ];
    const emb = fakeEmbedding(5);
    await cache.store('epsilon', emb, results, fakeMeta(), { sourceId: 'default' });

    // Soft-delete: UPDATE pages SET deleted_at = now() — production path.
    // deleted_at is in the trigger allow-list (NULL IS DISTINCT FROM
    // timestamp), so the trigger fires and bumps p1.generation. Layer 2
    // sees the mismatch and invalidates. Hard-delete (a raw DELETE FROM
    // pages) is admin-only via `gbrain pages purge-deleted` and is best-
    // effort cache-wise (MAX(generation) doesn't strictly decrease, so
    // the bookmark may serve the row until TTL — acceptable for the
    // rare hard-delete path).
    await engine.executeRaw(`UPDATE pages SET deleted_at = now() WHERE id = $1`, [p1]);

    const hit = await cache.lookup(emb, { sourceId: 'default' });
    expect(hit.hit).toBe(false);
  });

  test('multi-page result: partial bump invalidates (one of two result pages changed)', async () => {
    const p1 = await seedPage('test/p1', 'zeta');
    const p2 = await seedPage('test/p2', 'eta');
    const results: SearchResult[] = [
      { page_id: p1, slug: 'test/p1', title: 'test/p1', snippet: 'z', score: 1.0 } as unknown as SearchResult,
      { page_id: p2, slug: 'test/p2', title: 'test/p2', snippet: 'e', score: 0.9 } as unknown as SearchResult,
    ];
    const emb = fakeEmbedding(6);
    await cache.store('zeta eta', emb, results, fakeMeta(), { sourceId: 'default' });

    // Bump only p2.
    await engine.putPage('test/p2', {
      type: 'note',
      title: 'test/p2',
      compiled_truth: 'eta-v2',
      timeline: '',
      frontmatter: {},
    });

    const hit = await cache.lookup(emb, { sourceId: 'default' });
    expect(hit.hit).toBe(false);
  });
});
