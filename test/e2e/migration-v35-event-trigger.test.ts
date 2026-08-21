/**
 * E2E for migration v35 (#3603): the auto-RLS event trigger must be
 * create-if-absent so managed Postgres — where CREATE EVENT TRIGGER is
 * reserved to the master user and no reachable role has rolsuper — can
 * converge after a one-time pre-create instead of stalling the schema at
 * v34 forever.
 *
 * Pins, against real Postgres (the test role is a superuser, so both the
 * create and the pre-existing paths are exercisable):
 *   1. Absent trigger → running v35's Postgres SQL creates function + trigger.
 *   2. Running the same SQL again converges WITHOUT touching the trigger:
 *      same pg_event_trigger oid. Pre-fix, DROP+CREATE minted a new oid on
 *      every run (and on managed Postgres failed outright for any non-owner
 *      role, which is every reachable role).
 *
 * Gated by DATABASE_URL — skips when unset per CLAUDE.md lifecycle.
 *
 * Run: DATABASE_URL=... bun test test/e2e/migration-v35-event-trigger.test.ts
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';
import * as db from '../../src/core/db.ts';
import { MIGRATIONS } from '../../src/core/migrate.ts';

const skip = !hasDatabase();
const describeE2E = skip ? describe.skip : describe;

if (skip) {
  console.log('Skipping migration v35 event-trigger E2E tests (DATABASE_URL not set)');
}

const v35Sql =
  ((MIGRATIONS.find((m) => m.version === 35)?.sqlFor as { postgres?: string } | undefined)
    ?.postgres ?? '');

describeE2E('migration v35 — event trigger converges idempotently (#3603)', () => {
  // Fresh DBs apply the full migration chain in setupDB — allow for it.
  beforeAll(async () => {
    await setupDB();
  }, 120_000);

  afterAll(async () => {
    // Best-effort restore: if an assertion aborted mid-test with the trigger
    // dropped, leave the DB in the post-v35 state for sibling suites (their
    // initSchema won't re-run v35 — config.version is already at latest).
    try {
      await db.getConnection().unsafe(v35Sql);
    } catch {
      /* superuser test roles never hit the privilege path; ignore */
    }
    await teardownDB();
  });

  test('absent trigger → v35 SQL creates it; re-run leaves it untouched', async () => {
    expect(v35Sql.length).toBeGreaterThan(0);
    const conn = db.getConnection();

    // Simulate the pre-v35 state. Trigger first (the function is its dependency).
    await conn.unsafe(`DROP EVENT TRIGGER IF EXISTS auto_rls_on_create_table`);
    await conn.unsafe(`DROP FUNCTION IF EXISTS auto_enable_rls()`);

    // Run 1: creates function + trigger from scratch (fresh-install path).
    await conn.unsafe(v35Sql);
    const t1 = await conn.unsafe(
      `SELECT oid::text AS oid FROM pg_event_trigger WHERE evtname = 'auto_rls_on_create_table'`,
    );
    expect(t1.length).toBe(1);
    const f1 = await conn.unsafe(
      `SELECT oid::text AS oid FROM pg_proc WHERE proname = 'auto_enable_rls'`,
    );
    expect(f1.length).toBe(1);

    // Run 2: must converge as a pure no-op on both objects. The trigger oid is
    // the discriminator — pre-fix DROP+CREATE minted a NEW oid on every run
    // (and required owner/superuser rights even when the trigger existed).
    await conn.unsafe(v35Sql);
    const t2 = await conn.unsafe(
      `SELECT oid::text AS oid FROM pg_event_trigger WHERE evtname = 'auto_rls_on_create_table'`,
    );
    expect(t2.length).toBe(1);
    expect(t2[0].oid).toBe(t1[0].oid);
    const f2 = await conn.unsafe(
      `SELECT oid::text AS oid FROM pg_proc WHERE proname = 'auto_enable_rls'`,
    );
    expect(f2[0].oid).toBe(f1[0].oid);
  }, 30000);

  test('pre-created trigger (managed-Postgres master runbook) → v35 SQL passes without owning it', async () => {
    const conn = db.getConnection();
    // The trigger + function already exist from the previous test (or from
    // initSchema). Running the migration SQL again must not DROP, REPLACE, or
    // re-CREATE either object — that's exactly the operation a non-owner app
    // role cannot perform on managed Postgres.
    const before = await conn.unsafe(
      `SELECT oid::text AS oid FROM pg_event_trigger WHERE evtname = 'auto_rls_on_create_table'`,
    );
    expect(before.length).toBe(1);
    await conn.unsafe(v35Sql);
    const after = await conn.unsafe(
      `SELECT oid::text AS oid FROM pg_event_trigger WHERE evtname = 'auto_rls_on_create_table'`,
    );
    expect(after[0].oid).toBe(before[0].oid);
  }, 30000);
});
