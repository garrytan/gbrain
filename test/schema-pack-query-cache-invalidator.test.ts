// v0.40.6.0 — query-cache-invalidator.ts contract tests.
//
// Pins the C9 fix: schema mutations DELETE the query_cache for the
// affected source so cached search results bound to old page types
// don't survive a `sync --apply`.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { invalidateQueryCache } from '../src/core/schema-pack/query-cache-invalidator.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

async function seedCacheRow(sourceId: string, queryText: string): Promise<void> {
  // Use raw INSERT to bypass the semantic-similarity path. We're testing the
  // CLEAR behavior, not the LOOKUP behavior.
  await engine.executeRaw(
    `INSERT INTO query_cache (id, query_text, source_id, knobs_hash, embedding, results, meta, ttl_seconds, created_at)
     VALUES ($1, $2, $3, 'v3:test', NULL, '[]'::jsonb, '{}'::jsonb, 3600, now())`,
    [`${sourceId}-${queryText}-id`, queryText, sourceId],
  );
}

async function countCacheRows(sourceId?: string): Promise<number> {
  const sql = sourceId
    ? `SELECT COUNT(*)::int AS n FROM query_cache WHERE source_id = $1`
    : `SELECT COUNT(*)::int AS n FROM query_cache`;
  const rows = await engine.executeRaw<{ n: number }>(sql, sourceId ? [sourceId] : []);
  return rows[0]?.n ?? 0;
}

describe('invalidateQueryCache', () => {
  it('clears all rows for a given source_id', async () => {
    await seedCacheRow('source-a', 'q1');
    await seedCacheRow('source-a', 'q2');
    await seedCacheRow('source-b', 'q1');
    expect(await countCacheRows('source-a')).toBe(2);

    const result = await invalidateQueryCache(engine, 'source-a');
    expect(result.rows_invalidated).toBe(2);
    expect(await countCacheRows('source-a')).toBe(0);
    expect(await countCacheRows('source-b')).toBe(1);
  });

  it('clears all rows when sourceId is omitted', async () => {
    await seedCacheRow('source-a', 'q1');
    await seedCacheRow('source-b', 'q2');
    const result = await invalidateQueryCache(engine);
    expect(result.rows_invalidated).toBe(2);
    expect(await countCacheRows()).toBe(0);
  });

  it('is idempotent on empty cache', async () => {
    const r1 = await invalidateQueryCache(engine, 'source-a');
    const r2 = await invalidateQueryCache(engine, 'source-a');
    expect(r1.rows_invalidated).toBe(0);
    expect(r2.rows_invalidated).toBe(0);
  });

  it('returns {rows_invalidated: 0} silently if engine call fails (never throws)', async () => {
    // Build a stub engine whose executeRaw always throws.
    const broken = {
      kind: 'pglite',
      executeRaw: async () => { throw new Error('synthetic'); },
    } as unknown as PGLiteEngine;
    const result = await invalidateQueryCache(broken, 'source-a');
    expect(result.rows_invalidated).toBe(0);
  });
});
