/**
 * Regression: hnsw.ef_search (pgvector default 40) silently caps the vector
 * candidate pool below what searchVector asks for.
 *
 * searchVector's inner CTE requests `offset + max(limit*5, 100)` candidates,
 * but an HNSW index scan returns at most `hnsw.ef_search` rows (default 40) —
 * the GUC sizes the scan's candidate list, so any LIMIT past 40 was
 * unreachable. Measured on this fixture before the fix: 150 matching pages,
 * limit=100 → 40 rows. The fix (hnswEfSearchFor) raises the GUC
 * transaction-locally to match the candidate request.
 *
 * Planner forcing: on a 150-row corpus the planner prefers a seq scan (or a
 * different index + explicit Sort), which bypasses the HNSW cap entirely and
 * would let this test pass without the fix. `enable_seqscan=off` +
 * `enable_sort=off` make the HNSW-ordered scan the only cheap plan — the
 * same forcing technique pgvector's own regression suite uses. Session GUCs
 * persist into the search's transaction; the fix's SET LOCAL is orthogonal
 * to them. Fixture geometry notes: test/helpers/ef-search-fixture.ts.
 *
 * Postgres half: test/e2e/vector-ef-search-postgres.test.ts.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  hnswEfSearchFor,
  HNSW_EF_SEARCH_DEFAULT,
  HNSW_EF_SEARCH_MAX,
} from '../src/core/vector-index.ts';
import {
  SEARCH_LIMIT,
  prngUnitVector,
  embeddingDims,
  seedCorpus,
} from './helpers/ef-search-fixture.ts';

describe('hnswEfSearchFor', () => {
  test('floors at the pgvector default', () => {
    expect(hnswEfSearchFor(0)).toBe(HNSW_EF_SEARCH_DEFAULT);
    expect(hnswEfSearchFor(39)).toBe(HNSW_EF_SEARCH_DEFAULT);
  });

  test('tracks the candidate request past the default', () => {
    expect(hnswEfSearchFor(100)).toBe(100);
    expect(hnswEfSearchFor(500)).toBe(500); // limit=100 → innerLimit 500
  });

  test('caps at the GUC maximum', () => {
    expect(hnswEfSearchFor(5000)).toBe(HNSW_EF_SEARCH_MAX);
  });
});

describe('searchVector candidate pool vs hnsw.ef_search (PGLite)', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    const dim = await embeddingDims(engine);
    await seedCorpus(engine, dim);
    // Force the HNSW-ordered plan (see header). Session-level on PGLite's
    // single connection, so it holds for the searches below.
    await engine.executeRaw(`SET enable_seqscan = off`);
    await engine.executeRaw(`SET enable_sort = off`);
  }, 240_000);

  afterAll(async () => {
    await engine.disconnect();
  });

  test('a limit past the ef_search default is honored', async () => {
    const dim = await embeddingDims(engine);
    const results = await engine.searchVector(prngUnitVector(0, dim), {
      limit: SEARCH_LIMIT,
    });
    // Pre-fix this was exactly 40 (the hnsw.ef_search default): the HNSW
    // scan exhausted its candidate list long before the inner CTE's LIMIT.
    expect(results.length).toBe(SEARCH_LIMIT);
  }, 60_000);
});
