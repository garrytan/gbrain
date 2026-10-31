/**
 * GBRA-75 wave 7: PostgresEngine's search guard. A brain whose search planner
 * statistics are absent (pg_upgrade, a deleted pg_statistic) gets them from the
 * first pool search, in the background; a search inside a transaction never
 * starts the guard (it may hold the pool's only connection).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { getEngine, hasDatabase, importFixtures, setupDB, teardownDB } from './helpers.ts';
import { missingSearchStatistics, SEARCH_STATISTICS_COLUMNS } from '../../src/core/search/projection-statistics.ts';

const d = hasDatabase() ? describe : describe.skip;

d('search planner statistics guard on Postgres', () => {
  beforeAll(async () => {
    await setupDB();
    await importFixtures();
    const engine = getEngine();
    // Autovacuum is a second ANALYZE of pages that the guard does not own: on the shared e2e database it can restore
    // the deleted statistics between beforeAll and a check (a gate failure; forced with autovacuum_naptime=1s and a
    // zero analyze threshold, 2 of 3 runs). The SET waits out an analyze already running and keeps new ones off.
    await engine.executeRaw('ALTER TABLE pages SET (autovacuum_enabled = false)');
    await engine.executeRaw('ANALYZE pages');
    await engine.executeRaw('ANALYZE content_chunks');
    await engine.executeRaw("DELETE FROM pg_statistic WHERE starelid = 'pages'::regclass");
    // The fixtures are a few pages; the guard only acts on a table sampled at 500 rows or more (reltuples, which a
    // deleted pg_statistic keeps), so the fixture stands in for a large brain that lost its statistics.
    await engine.executeRaw("UPDATE pg_class SET reltuples = 5000 WHERE oid = 'pages'::regclass");
  }, 60_000);
  afterAll(async () => {
    await getEngine().executeRaw('ALTER TABLE pages RESET (autovacuum_enabled)');
    await teardownDB();
  });

  const pagesMissing = SEARCH_STATISTICS_COLUMNS.pages.map(c => `pages.${c}`);

  test('a search inside a transaction does not start the guard', async () => {
    const engine = getEngine();
    expect(await missingSearchStatistics(engine)).toEqual(pagesMissing);
    await engine.transaction(tx => tx.searchKeyword('fixture'));
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(await missingSearchStatistics(engine)).toEqual(pagesMissing);
  });

  test('the first pool search collects the absent statistics without waiting for them', async () => {
    const engine = getEngine();
    await engine.searchKeyword('fixture');
    let missing = await missingSearchStatistics(engine);
    for (let i = 0; i < 50 && missing.length > 0; i++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      missing = await missingSearchStatistics(engine);
    }
    expect(missing).toEqual([]);
  }, 30_000);
});
