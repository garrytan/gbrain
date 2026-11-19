/**
 * #9779 on real Postgres: the twin of test/long-title-index-9779.test.ts. The
 * v326 replacement builds and drops CONCURRENTLY here, so this is the arm that
 * proves the online path.
 *
 * Gated by DATABASE_URL — skips gracefully without real Postgres.
 */
import { afterAll, beforeEach, describe, test } from 'bun:test';
import { getEngine, hasDatabase, setupDB, teardownDB } from './helpers.ts';
import { expectReplacementPastV240, expectUpgradeFromBeforeV240 } from '../helpers/long-title-index.ts';

const describePg = hasDatabase() ? describe : describe.skip;

describePg('long page titles (#9779, Postgres)', () => {
  beforeEach(async () => { await setupDB(); }, 240_000);
  afterAll(async () => { await teardownDB(); });

  test('a brain before v240 holding 3,000-byte and 100 KB titles upgrades, and the pages are found by title through the index', async () => {
    await expectUpgradeFromBeforeV240(getEngine());
  }, 240_000);

  test('a brain with the old title btree gets the hash index, then saves a 3,000-byte title; a rerun changes nothing', async () => {
    await expectReplacementPastV240(getEngine());
  }, 240_000);
});
