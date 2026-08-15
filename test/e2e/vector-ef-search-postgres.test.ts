/**
 * Postgres half of the hnsw.ef_search regression — see
 * test/vector-ef-search.test.ts for the full rationale (PGLite half + the
 * hnswEfSearchFor unit tests) and test/helpers/ef-search-fixture.ts for the
 * fixture-geometry notes.
 *
 * Engine-specific mechanics:
 *  - Planner forcing happens via `ALTER DATABASE … SET enable_seqscan/
 *    enable_sort = off` because the engine runs searches on a connection
 *    pool: a session-level SET would land on one pooled connection while
 *    searchVector's transaction may run on another. Database-level settings
 *    apply at connection start, so a fresh engine (fresh pool) created after
 *    the ALTER sees them deterministically. afterAll RESETs both.
 *  - Gated on DATABASE_URL like the other e2e files.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { hasDatabase, setupDB, teardownDB, getEngine } from './helpers.ts';
import {
  SEARCH_LIMIT,
  prngUnitVector,
  embeddingDims,
  seedCorpus,
} from '../helpers/ef-search-fixture.ts';

const SKIP = !hasDatabase();
const describeDb = SKIP ? describe.skip : describe;

describeDb('searchVector candidate pool vs hnsw.ef_search (Postgres)', () => {
  let searchEngine: PostgresEngine | null = null;
  let quotedDb: string | null = null;

  beforeAll(async () => {
    const seedEngine = await setupDB();
    const dim = await embeddingDims(seedEngine);
    await seedCorpus(seedEngine, dim);

    const rows = await seedEngine.executeRaw<{ db: string }>(
      `SELECT current_database() AS db`,
    );
    quotedDb = `"${rows[0]!.db.replaceAll('"', '""')}"`;
    await seedEngine.executeRaw(`ALTER DATABASE ${quotedDb} SET enable_seqscan = off`);
    await seedEngine.executeRaw(`ALTER DATABASE ${quotedDb} SET enable_sort = off`);

    // Fresh pool so its connections inherit the database-level GUCs.
    // poolSize is required: without it connect() reuses the module-level
    // singleton pool that setupDB() already opened BEFORE the ALTER, whose
    // connections still carry the default planner GUCs.
    searchEngine = new PostgresEngine();
    await searchEngine.connect({
      database_url: process.env.DATABASE_URL!,
      poolSize: 1,
    });
  }, 120_000);

  afterAll(async () => {
    try {
      if (quotedDb) {
        await getEngine().executeRaw(`ALTER DATABASE ${quotedDb} RESET enable_seqscan`);
        await getEngine().executeRaw(`ALTER DATABASE ${quotedDb} RESET enable_sort`);
      }
    } finally {
      if (searchEngine) await searchEngine.disconnect();
      await teardownDB();
    }
  }, 60_000);

  test('a limit past the ef_search default is honored', async () => {
    const dim = await embeddingDims(searchEngine!);
    const results = await searchEngine!.searchVector(prngUnitVector(0, dim), {
      limit: SEARCH_LIMIT,
    });
    // Pre-fix this was exactly 40 (the hnsw.ef_search default): the HNSW
    // scan exhausted its candidate list long before the inner CTE's LIMIT.
    expect(results.length).toBe(SEARCH_LIMIT);
  }, 60_000);
});
