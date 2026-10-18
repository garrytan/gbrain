/**
 * Wave B: migration v248 leaves the search statistics complete on an upgraded
 * Postgres brain. Search's chunk visibility predicate reads
 * pages.body_generation and content_chunks.body_generation;
 * columns added by ALTER TABLE have no pg_stats rows until ANALYZE, and
 * without them vector search drops its HNSW plan
 * (test/e2e/vector-chunk-statistics-postgres.test.ts).
 *
 * Fails when: v248 stops collecting statistics for the generation columns, or
 * SEARCH_STATISTICS_COLUMNS stops naming them.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { getEngine, hasDatabase, importFixtures, setupDB, teardownDB } from './helpers.ts';
import { missingSearchStatistics } from '../../src/core/search/projection-statistics.ts';
import { v248 } from '../../src/core/schema-migrations/v248-segmented-page-storage.ts';

const d = hasDatabase() ? describe : describe.skip;
const GENERATION_COLUMNS = ['pages.body_generation', 'content_chunks.body_generation'];

d('v248 search statistics on Postgres', () => {
  beforeAll(async () => {
    await setupDB();
    await importFixtures();
    const engine = getEngine();
    await engine.executeRaw('ANALYZE pages');
    await engine.executeRaw('ANALYZE content_chunks');
    // An upgraded brain: the pre-v248 columns are sampled, the columns v248 adds are not. The fixture stands in for a
    // large brain (missingSearchStatistics acts on tables sampled at 500 rows or more).
    await engine.executeRaw(`DELETE FROM pg_statistic s USING pg_attribute a
      WHERE a.attrelid = s.starelid AND a.attnum = s.staattnum
        AND ((a.attrelid = 'pages'::regclass AND a.attname = 'body_generation')
          OR (a.attrelid = 'content_chunks'::regclass AND a.attname = 'body_generation'))`);
    await engine.executeRaw("UPDATE pg_class SET reltuples = 5000 WHERE oid IN ('pages'::regclass, 'content_chunks'::regclass)");
  }, 60_000);
  afterAll(async () => { await teardownDB(); });

  test('the generation columns are search statistics, and v248 collects them', async () => {
    const engine = getEngine();
    expect(await missingSearchStatistics(engine)).toEqual(GENERATION_COLUMNS);
    await v248.handler!(engine);
    expect(await missingSearchStatistics(engine)).toEqual([]);
  });
});
