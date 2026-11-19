/**
 * #9779 on real Postgres: the twin of test/long-title-index-9779.test.ts. The
 * v240 and v326 builds run CONCURRENTLY here, so this is the arm that proves
 * the online path, including the rebuild of an INVALID leftover.
 *
 * Gated by DATABASE_URL — skips gracefully without real Postgres.
 */
import { afterAll, beforeEach, describe, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import postgres from '#postgres';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { assertSafeE2eDatabaseUrl, getEngine, hasDatabase, setupDB, teardownDB } from './helpers.ts';
import { expectFreshBrainHasTitleIndex, expectInvalidTitleIndexRebuilt, expectReplacementPastV240, expectReplayBuildsNoTitleIndex,
  expectUpgradeFromBeforeV240 } from '../helpers/long-title-index.ts';

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

  test('a boot that replays schema.sql on an existing brain builds no title index', async () => {
    await expectReplayBuildsNoTitleIndex(getEngine());
  }, 240_000);

  test('an INVALID title index left by an interrupted online build is dropped and rebuilt by the next upgrade', async () => {
    await expectInvalidTitleIndexRebuilt(getEngine());
  }, 240_000);

  test('a fresh brain has the index, valid', async () => {
    const url = process.env.DATABASE_URL!;
    assertSafeE2eDatabaseUrl(url);
    const name = `gbrain_test_title_${randomUUID().replace(/-/g, '')}`;
    const admin = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
    try {
      await admin.unsafe(`CREATE DATABASE ${name}`);
      const fresh = new PostgresEngine();
      try {
        const u = new URL(url);
        u.pathname = `/${name}`;
        await fresh.connect({ database_url: u.toString(), poolSize: 2 });
        await fresh.initSchema();
        await expectFreshBrainHasTitleIndex(fresh);
      } finally {
        await fresh.disconnect();
        await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      }
    } finally {
      await admin.end({ timeout: 5 });
    }
  }, 240_000);
});
