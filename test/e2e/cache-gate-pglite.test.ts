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

  test('v0.41.19.0 D20/CDX-6 inversion: legacy row (pre-v0.40.3.0 shape) invalidates when clock advances', async () => {
    const p1 = await seedPage('test/p1', 'gamma delta');
    const emb = fakeEmbedding(4);
    const results: SearchResult[] = [
      { page_id: p1, slug: 'test/p1', title: 'test/p1', snippet: 'g', score: 1.0 } as unknown as SearchResult,
    ];
    // Simulate a pre-v0.40.3.0 row: empty snapshot + zero bookmark.
    await cache.store('gamma delta', emb, results, fakeMeta(), { sourceId: 'default' });
    await engine.executeRaw(
      `UPDATE query_cache
          SET page_generations = '{}'::jsonb,
              max_generation_at_store = 0`,
    );

    // Write more pages. The global clock advances on every statement
    // (statement-level trigger from migration v105). Pre-v0.41.19.0 the
    // empty snapshot served vacuously here — that was the CDX-6 bug. Now:
    // Layer 1 fails (clock > 0), Layer 2 rejects empty snapshots, row
    // invalidates. Acceptable one-time post-upgrade cache miss; correct
    // semantics restored.
    await seedPage('test/p2', 'unrelated bump');
    await seedPage('test/p3', 'another unrelated bump');

    const hit = await cache.lookup(emb, { sourceId: 'default' });
    expect(hit.hit).toBe(false);
  });

  test('v0.41.19.0 CDX-1 regression: DELETE bumps clock → cached query for surviving pages invalidates', async () => {
    const p1 = await seedPage('test/p1', 'phi chi');
    const p2 = await seedPage('test/p2', 'phi chi extra');
    const results: SearchResult[] = [
      { page_id: p1, slug: 'test/p1', title: 'test/p1', snippet: 'p', score: 1.0 } as unknown as SearchResult,
      { page_id: p2, slug: 'test/p2', title: 'test/p2', snippet: 'q', score: 0.9 } as unknown as SearchResult,
    ];
    const emb = fakeEmbedding(7);
    await cache.store('phi chi', emb, results, fakeMeta(), { sourceId: 'default' });

    // Hard-delete via engine.deletePage. Pre-v0.41.19.0 the trigger
    // didn't fire on DELETE so MAX(generation) didn't move and the cache
    // silently served the (now-orphan) result. Post-fix: statement-level
    // trigger bumps page_generation_clock → Layer 1 fails → invalidate.
    await engine.deletePage('test/p1', { sourceId: 'default' });

    const hit = await cache.lookup(emb, { sourceId: 'default' });
    expect(hit.hit).toBe(false);
  });

  test('v0.41.19.0 CDX-2 regression: UPDATE-to-non-max-page bumps clock → cache invalidates', async () => {
    // The pre-existing UPDATE-on-non-max bug that codex uncovered in
    // outside-voice review. Sequence: insert p1 (gen=1), insert p2 (gen=2)
    // so MAX=2. Cache a query referencing only p1. UPDATE p1's compiled_truth
    // → row-level trigger sets p1.generation = OLD + 1 = 2 (NOT advancing
    // MAX). Pre-fix: Layer 1 (MAX(generation)=2) <= stored (>=2) → cache
    // served stale. Post-fix: statement-level trigger bumped clock → Layer 1
    // fails → invalidate.
    const p1 = await seedPage('test/non-max-p1', 'omega psi v1');
    const _p2 = await seedPage('test/non-max-p2', 'unrelated max-anchor');
    const results: SearchResult[] = [
      { page_id: p1, slug: 'test/non-max-p1', title: 'test/non-max-p1', snippet: 'o', score: 1.0 } as unknown as SearchResult,
    ];
    const emb = fakeEmbedding(8);
    await cache.store('omega psi', emb, results, fakeMeta(), { sourceId: 'default' });

    // UPDATE p1 (the non-max page) with new content.
    await engine.putPage('test/non-max-p1', {
      type: 'note',
      title: 'test/non-max-p1',
      compiled_truth: 'omega psi v2 — modified',
      timeline: '',
      frontmatter: {},
    });

    const hit = await cache.lookup(emb, { sourceId: 'default' });
    expect(hit.hit).toBe(false);
  });

  test('soft-delete result page → lookup MISS (trigger bumps generation)', async () => {
    const p1 = await seedPage('test/p1', 'epsilon');
    const results: SearchResult[] = [
      { page_id: p1, slug: 'test/p1', title: 'test/p1', snippet: 'e', score: 1.0 } as unknown as SearchResult,
    ];
    const emb = fakeEmbedding(5);
    await cache.store('epsilon', emb, results, fakeMeta(), { sourceId: 'default' });

    // Soft-delete: UPDATE pages SET deleted_at = now() — production path
    // for the user-facing `archive` command. The row-level trigger fires
    // (deleted_at is in the allow-list), bumping p1.generation; Layer 2
    // detects the mismatch and invalidates.
    //
    // Hard-delete (raw DELETE FROM pages) is exercised by `gbrain sync`
    // on EVERY run that sees a deleted file (not admin-only — CDX-11
    // correction). Post-v0.41.19.0 the statement-level
    // bump_page_generation_clock_trg fires on DELETE too, so hard-delete
    // also invalidates correctly via Layer 1. See the CDX-1 regression
    // test above for that path.
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
