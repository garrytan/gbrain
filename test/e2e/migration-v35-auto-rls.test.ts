/**
 * E2E tests for migration v35: auto_rls_event_trigger.
 *
 * Verifies the event trigger auto-enables RLS on newly created public.* tables
 * across CREATE TABLE / CREATE TABLE AS / SELECT INTO, plus the one-time
 * backfill of existing public.* tables without RLS (modulo the GBRAIN:RLS_EXEMPT
 * exemption that doctor honors). Postgres-only — PGLite has no RLS or event
 * triggers; that no-op is asserted in test/migrate.test.ts.
 *
 * setupDB() runs db.initSchema() which applies all migrations including v35,
 * so the trigger and the backfill have already executed by the time these
 * tests start.
 *
 * Run: DATABASE_URL=... bun test test/e2e/migration-v35-auto-rls.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { hasDatabase, setupDB, teardownDB, getConn, getEngine, runMigrationsUpTo } from './helpers.ts';
import { MIGRATIONS, LATEST_VERSION } from '../../src/core/migrate.ts';

const skip = !hasDatabase();
const describeE2E = skip ? describe.skip : describe;

if (skip) {
  console.log('Skipping auto-RLS E2E tests (DATABASE_URL not set)');
}

// Migration v35 lives at index 34 (0-based) in MIGRATIONS.
const v35 = MIGRATIONS.find(m => m.version === 35);
const v35Sql = (v35?.sqlFor as any)?.postgres ?? '';

describeE2E('migration v35: auto_rls_event_trigger', () => {
  beforeAll(async () => {
    await setupDB();
    // setupDB() runs db.initSchema() (SCHEMA_SQL only, no migrations).
    // Advance through every migration so v35 is actually installed.
    await runMigrationsUpTo(getEngine(), LATEST_VERSION);
  });

  afterAll(async () => {
    const conn = getConn();
    // Clean up every artifact this file creates. Order matters because
    // _test_v35_scope lives in a non-public schema we drop wholesale.
    await conn.unsafe(`DROP TABLE IF EXISTS _test_auto_rls_check`);
    await conn.unsafe(`DROP TABLE IF EXISTS _test_ctas`);
    await conn.unsafe(`DROP TABLE IF EXISTS _test_select_into`);
    await conn.unsafe(`DROP TABLE IF EXISTS _test_backfill_plain`);
    await conn.unsafe(`DROP TABLE IF EXISTS _test_backfill_exempt`);
    await conn.unsafe(`DROP TABLE IF EXISTS "_test_BackfillCamelCase"`);
    await conn.unsafe(`DROP SCHEMA IF EXISTS _test_v35_scope CASCADE`);
    await teardownDB();
  });

  test('event trigger exists', async () => {
    const conn = getConn();
    const triggers = await conn`
      SELECT evtname FROM pg_event_trigger
      WHERE evtname = 'auto_rls_on_create_table'
    `;
    expect(triggers.length).toBe(1);
  });

  test('new tables automatically get RLS enabled (CREATE TABLE)', async () => {
    const conn = getConn();
    await conn`CREATE TABLE _test_auto_rls_check (id serial PRIMARY KEY, val text)`;

    const result = await conn`
      SELECT rowsecurity FROM pg_tables
      WHERE schemaname = 'public' AND tablename = '_test_auto_rls_check'
    `;
    expect(result.length).toBe(1);
    expect(result[0].rowsecurity).toBe(true);
  });

  test('auto_enable_rls function exists', async () => {
    const conn = getConn();
    const funcs = await conn`
      SELECT proname FROM pg_proc
      WHERE proname = 'auto_enable_rls'
    `;
    expect(funcs.length).toBe(1);
  });

  test('FORCE RLS is NOT applied (D1: ENABLE only)', async () => {
    // pg_class.relforcerowsecurity reflects FORCE; rowsecurity reflects ENABLE.
    // v35 enables only — operators or future migrations can opt FORCE in
    // explicitly per table if defense-in-depth is desired.
    const conn = getConn();
    const result = await conn`
      SELECT relforcerowsecurity FROM pg_class
      WHERE relname = '_test_auto_rls_check' AND relkind = 'r'
    `;
    expect(result.length).toBe(1);
    expect(result[0].relforcerowsecurity).toBe(false);
  });

  test('CREATE TABLE AS triggers auto-RLS (D6)', async () => {
    // CTAS is a distinct command_tag in Postgres ('CREATE TABLE AS'). The
    // trigger's WHEN TAG list covers it explicitly.
    const conn = getConn();
    await conn`CREATE TABLE _test_ctas AS SELECT 1 AS id, 'hello'::text AS val`;

    const result = await conn`
      SELECT rowsecurity FROM pg_tables
      WHERE schemaname = 'public' AND tablename = '_test_ctas'
    `;
    expect(result.length).toBe(1);
    expect(result[0].rowsecurity).toBe(true);
  });

  test('SELECT INTO triggers auto-RLS (D6)', async () => {
    // SELECT INTO is the older synonym for CTAS. Postgres tags it 'SELECT INTO'.
    const conn = getConn();
    await conn`SELECT 1 AS id, 'world'::text AS val INTO _test_select_into`;

    const result = await conn`
      SELECT rowsecurity FROM pg_tables
      WHERE schemaname = 'public' AND tablename = '_test_select_into'
    `;
    expect(result.length).toBe(1);
    expect(result[0].rowsecurity).toBe(true);
  });

  test('non-public schemas are not touched (D2)', async () => {
    // Build a private schema and a table inside. The trigger filters
    // schema_name = 'public' so this table should remain RLS-off.
    const conn = getConn();
    await conn`CREATE SCHEMA IF NOT EXISTS _test_v35_scope`;
    await conn`CREATE TABLE _test_v35_scope.private_tbl (id int)`;

    const result = await conn`
      SELECT relrowsecurity FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = '_test_v35_scope' AND c.relname = 'private_tbl'
    `;
    expect(result.length).toBe(1);
    expect(result[0].relrowsecurity).toBe(false);
  });

  test('replay idempotency: re-running migration leaves exactly one trigger', async () => {
    const conn = getConn();
    expect(v35Sql.length).toBeGreaterThan(0);
    // Re-execute the entire v35 SQL. The DROP EVENT TRIGGER IF EXISTS +
    // CREATE EVENT TRIGGER pattern must be a clean round-trip. The backfill
    // DO block runs again too, but is a no-op since RLS is now on everywhere.
    await conn.unsafe(v35Sql);

    const triggers = await conn`
      SELECT evtname FROM pg_event_trigger
      WHERE evtname = 'auto_rls_on_create_table'
    `;
    expect(triggers.length).toBe(1);

    const funcs = await conn`SELECT proname FROM pg_proc WHERE proname = 'auto_enable_rls'`;
    expect(funcs.length).toBe(1);
  });

  test('backfill enables RLS on pre-existing public.* tables', async () => {
    const conn = getConn();
    // Temporarily drop the trigger so we can create a table WITHOUT RLS,
    // simulating a pre-v35 row.
    await conn`DROP EVENT TRIGGER IF EXISTS auto_rls_on_create_table`;
    try {
      await conn`CREATE TABLE _test_backfill_plain (id serial PRIMARY KEY)`;
      // Belt-and-suspenders: explicitly disable RLS on this fresh table.
      await conn`ALTER TABLE _test_backfill_plain DISABLE ROW LEVEL SECURITY`;

      const before = await conn`
        SELECT rowsecurity FROM pg_tables WHERE tablename = '_test_backfill_plain'
      `;
      expect(before[0].rowsecurity).toBe(false);

      // Re-run v35: trigger comes back AND the backfill DO block flips this
      // table to RLS-on (no exempt comment, schema is public, relkind='r').
      await conn.unsafe(v35Sql);

      const after = await conn`
        SELECT rowsecurity FROM pg_tables WHERE tablename = '_test_backfill_plain'
      `;
      expect(after[0].rowsecurity).toBe(true);
    } finally {
      // Make sure the trigger is restored even if assertions throw.
      const triggers = await conn`
        SELECT evtname FROM pg_event_trigger WHERE evtname = 'auto_rls_on_create_table'
      `;
      if (triggers.length === 0) {
        await conn.unsafe(v35Sql);
      }
    }
  });

  test('backfill respects GBRAIN:RLS_EXEMPT comment (matches doctor regex)', async () => {
    const conn = getConn();
    await conn`DROP EVENT TRIGGER IF EXISTS auto_rls_on_create_table`;
    try {
      await conn`CREATE TABLE _test_backfill_exempt (id serial PRIMARY KEY)`;
      await conn`ALTER TABLE _test_backfill_exempt DISABLE ROW LEVEL SECURITY`;
      // Comment must match doctor.ts EXEMPT_RE: /^GBRAIN:RLS_EXEMPT\s+reason=\S.{3,}/
      // — "test exempt" is 11 chars after `reason=`, well over the .{3,} floor.
      await conn`COMMENT ON TABLE _test_backfill_exempt IS 'GBRAIN:RLS_EXEMPT reason=test exempt'`;

      // Re-run the migration. Backfill should skip this row.
      await conn.unsafe(v35Sql);

      const after = await conn`
        SELECT rowsecurity FROM pg_tables WHERE tablename = '_test_backfill_exempt'
      `;
      expect(after[0].rowsecurity).toBe(false);
    } finally {
      const triggers = await conn`
        SELECT evtname FROM pg_event_trigger WHERE evtname = 'auto_rls_on_create_table'
      `;
      if (triggers.length === 0) {
        await conn.unsafe(v35Sql);
      }
    }
  });

  test('backfill quotes mixed-case identifiers safely (%I.%I)', async () => {
    const conn = getConn();
    await conn`DROP EVENT TRIGGER IF EXISTS auto_rls_on_create_table`;
    try {
      // Mixed-case table names require double-quoting in DDL. If the backfill
      // used %s with raw concat, ALTER TABLE public._test_BackfillCamelCase
      // would fail with "relation does not exist" because Postgres folds
      // unquoted identifiers to lowercase.
      await conn`CREATE TABLE "_test_BackfillCamelCase" (id serial PRIMARY KEY)`;
      await conn`ALTER TABLE "_test_BackfillCamelCase" DISABLE ROW LEVEL SECURITY`;

      await conn.unsafe(v35Sql);

      const after = await conn`
        SELECT relrowsecurity FROM pg_class
        WHERE relname = '_test_BackfillCamelCase' AND relkind = 'r'
      `;
      expect(after.length).toBe(1);
      expect(after[0].relrowsecurity).toBe(true);
    } finally {
      const triggers = await conn`
        SELECT evtname FROM pg_event_trigger WHERE evtname = 'auto_rls_on_create_table'
      `;
      if (triggers.length === 0) {
        await conn.unsafe(v35Sql);
      }
    }
  });

  test('regression guard: trigger function body does NOT contain EXCEPTION WHEN OTHERS', async () => {
    // Codex correctly identified that wrapping the per-table EXECUTE in
    // BEGIN…EXCEPTION WHEN OTHERS… would convert a transactional rollback
    // (loud) into a silent permissive default (quiet). Pin that by reading
    // the function body from pg_proc and grepping it.
    const conn = getConn();
    const rows = await conn`
      SELECT prosrc FROM pg_proc WHERE proname = 'auto_enable_rls'
    `;
    expect(rows.length).toBe(1);
    const body = rows[0].prosrc as string;
    expect(body.toUpperCase()).not.toContain('EXCEPTION WHEN OTHERS');
  });
});
