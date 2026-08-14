/**
 * Regression coverage for query-cache JSONB writes through postgres.js.
 *
 * PGLite accepts JSON.stringify(payload)::jsonb as an array/object, while
 * postgres.js can encode the same parameter as a JSONB string. This test must
 * run against real PostgreSQL so it fails on the pre-normalization write path.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SemanticQueryCache } from '../../src/core/search/query-cache.ts';
import type { HybridSearchMeta, SearchResult } from '../../src/core/types.ts';
import { getEngine, hasDatabase, setupDB, teardownDB } from './helpers.ts';

const RUN = hasDatabase();
const describePostgres = RUN ? describe : describe.skip;

const RESULT: SearchResult = {
  slug: 'concepts/query-cache-jsonb',
  page_id: 1,
  title: 'Query cache JSONB',
  type: 'concept',
  chunk_text: 'PostgreSQL JSONB regression fixture',
  chunk_source: 'compiled_truth',
  chunk_id: 1,
  chunk_index: 0,
  score: 1,
  stale: false,
};

const META: HybridSearchMeta = {
  vector_enabled: true,
  detail_resolved: 'medium',
  expansion_applied: false,
};

describePostgres('SemanticQueryCache PostgreSQL JSONB storage (E2E)', () => {
  beforeAll(async () => {
    await setupDB();
  }, 60_000);

  afterAll(async () => {
    await teardownDB();
  }, 30_000);

  test('stores results as an array and meta as an object', async () => {
    const engine = getEngine();
    const cache = new SemanticQueryCache(engine);
    const embedding = new Float32Array(1536);
    embedding[0] = 1;

    await cache.store('query-cache-jsonb-e2e', embedding, [RESULT], META);

    const [stored] = await engine.executeRaw<{
      results_type: string;
      meta_type: string;
    }>(
      `SELECT jsonb_typeof(results) AS results_type,
              jsonb_typeof(meta) AS meta_type
         FROM query_cache
        WHERE query_text = $1`,
      ['query-cache-jsonb-e2e'],
    );

    expect(stored).toBeDefined();
    expect(stored.results_type).toBe('array');
    expect(stored.meta_type).toBe('object');
  });
});
