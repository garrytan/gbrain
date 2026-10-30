/**
 * Every public table has row-level security after a fresh install and after
 * the migrations-only upgrade path (#GBRA-95 class: Wave B PR 4's v273 tables
 * shipped with RLS off on Postgres).
 *
 * Supabase grants anon and authenticated default privileges on public tables,
 * so a gbrain table without RLS is readable and writable with the anon key
 * whenever the Data API is on. gbrain enables RLS in three places: the schema
 * blob's DO blocks (replayed by a full initSchema), per-migration DO blocks,
 * and v35's auto-RLS event trigger. The trigger is superuser-only and absent
 * or inert on many managed brains, and `gbrain apply-migrations --yes` runs
 * migrations without replaying the blob, so a migration that creates a table
 * must enable RLS itself. On a superuser test database the trigger exists and
 * hides that gap, so each case here starts from a scratch database where the
 * trigger is pre-created DISABLED (v35 is create-if-absent and converges on
 * it, as it does on a managed brain whose master user created it).
 *
 * The only exemption is a table carrying the documented
 * `GBRAIN:RLS_EXEMPT reason=...` comment (the regex doctor's rls check uses).
 * A new table that relies on the event trigger or on the blob alone fails here.
 * Run: DATABASE_URL=... bun test test/e2e/rls-every-table-postgres.test.ts
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import postgres from '#postgres';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
import { collect, makeHome, spawnDriver } from '../helpers/apply-migrations-lock-driver.ts';
import { writeSchemaDriver } from '../helpers/apply-migrations-schema-driver.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { LATEST_VERSION } from '../../src/core/migrate.ts';
import { v275 } from '../../src/core/schema-migrations/v275-rls-backfill-unguarded-tables.ts';
import { recreateStep } from '../../src/core/schema-missing-tables.ts';
import { resolveRepairScope, runRepair } from '../../src/core/repair/core.ts';
import { missingTablesRepair } from '../../src/core/repair/missing-tables.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { withEnv } from '../helpers/with-env.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const describeE2E = DATABASE_URL ? describe : describe.skip;

const V273_TABLES = ['page_derivation_spend', 'page_segment_derivation_purge_pages', 'page_segment_derivation_purges', 'page_segment_derivations'];

const scratch: string[] = [];
const homes: string[] = [];
let admin: ReturnType<typeof postgres> | null = null;

function urlFor(name: string): string {
  const url = new URL(DATABASE_URL!);
  url.pathname = `/${name}`;
  return url.toString();
}

/** A scratch database whose v35 auto-RLS event trigger exists but never fires. */
async function scratchDatabase(): Promise<{ url: string; conn: ReturnType<typeof postgres> }> {
  assertSafeE2eDatabaseUrl(DATABASE_URL!);
  admin ??= postgres(DATABASE_URL!, { max: 1, prepare: false });
  const name = `gbrain_test_rls_${randomUUID().replaceAll('-', '')}`;
  await admin.unsafe(`CREATE DATABASE ${name}`);
  scratch.push(name);
  const url = urlFor(name);
  const conn = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  await conn.unsafe(`CREATE FUNCTION auto_enable_rls() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN END $$`);
  await conn.unsafe(`CREATE EVENT TRIGGER auto_rls_on_create_table ON ddl_command_end WHEN TAG IN ('CREATE TABLE') EXECUTE FUNCTION auto_enable_rls()`);
  await conn.unsafe(`ALTER EVENT TRIGGER auto_rls_on_create_table DISABLE`);
  return { url, conn };
}

async function freshInit(url: string): Promise<void> {
  const engine = new PostgresEngine();
  await engine.connect({ database_url: url });
  try { await engine.initSchema(); } finally { await engine.disconnect(); }
}

/** Public base tables without RLS, minus the documented GBRAIN:RLS_EXEMPT ones. */
async function tablesWithoutRls(conn: ReturnType<typeof postgres>): Promise<string[]> {
  const rows = await conn.unsafe<Array<{ relname: string }>>(`
    SELECT c.relname FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_description d ON d.objoid = c.oid AND d.classoid = 'pg_class'::regclass AND d.objsubid = 0
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relrowsecurity
       AND (d.description IS NULL OR d.description !~ '^GBRAIN:RLS_EXEMPT\\s+reason=\\S.{3,}')
     ORDER BY c.relname`);
  return rows.map(r => r.relname);
}

async function presentTables(conn: ReturnType<typeof postgres>, names: string[]): Promise<string[]> {
  const rows = await conn.unsafe<Array<{ relname: string }>>(
    `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = ANY($1::text[]) ORDER BY c.relname`, [names]);
  return rows.map(r => r.relname);
}

describeE2E('RLS on every public table (Postgres, no auto-RLS event trigger)', () => {
  afterAll(async () => {
    if (admin) {
      for (const name of scratch) await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    }
    for (const home of homes) rmSync(home, { recursive: true, force: true });
  });

  test('a fresh initSchema leaves no public table without RLS', async () => {
    const { url, conn } = await scratchDatabase();
    try {
      await freshInit(url);
      expect(await presentTables(conn, V273_TABLES)).toEqual(V273_TABLES);
      expect(await tablesWithoutRls(conn)).toEqual([]);
    } finally {
      await conn.end();
    }
  }, 300_000);

  test('a brain at v272 upgraded with `gbrain apply-migrations --yes` (no blob replay) leaves no public table without RLS', async () => {
    const { url, conn } = await scratchDatabase();
    try {
      await freshInit(url);
      // Rewind to the schema before v273: drop what v273 and v274 create and stamp version 272.
      await conn.unsafe(`DROP TABLE page_segment_derivation_purge_pages, page_segment_derivation_purges, page_derivation_spend, page_segment_derivations CASCADE`);
      await conn.unsafe(`DROP TRIGGER IF EXISTS page_body_manifest_derivation_scope_retire ON page_body_manifest;
        DROP TRIGGER IF EXISTS page_body_manifest_derivation_scope_delete ON page_body_manifest;
        DROP TRIGGER IF EXISTS pages_derivation_scope_delete ON pages;
        DROP FUNCTION IF EXISTS gbrain_mark_derivation_scope_entry();
        DROP FUNCTION IF EXISTS gbrain_refuse_purging_derivation();
        ALTER TABLE facts DROP CONSTRAINT IF EXISTS facts_source_window_chk, DROP COLUMN IF EXISTS source_window;
        ALTER TABLE pages DROP COLUMN IF EXISTS withheld_source_path;`);
      await conn.unsafe(`UPDATE config SET value = '272' WHERE key = 'version'`);
      expect(await presentTables(conn, V273_TABLES)).toEqual([]);

      const home = makeHome({ engine: 'postgres', database_url: url });
      homes.push(home);
      const run = await collect(spawnDriver(home, writeSchemaDriver(home, { migrations: [], args: ['--yes', '--non-interactive', '--no-autopilot-install', '--json'] })));
      expect(run.code, run.stderr + run.stdout).toBe(0);
      const version = await conn.unsafe<Array<{ value: string }>>(`SELECT value FROM config WHERE key = 'version'`);
      expect(Number(version[0]?.value)).toBe(LATEST_VERSION);

      expect(await presentTables(conn, V273_TABLES)).toEqual(V273_TABLES);
      expect(await tablesWithoutRls(conn)).toEqual([]);
    } finally {
      await conn.end();
    }
  }, 300_000);

  test('every public table with RLS turned off at the version before v275, upgraded with `gbrain apply-migrations --yes`, ends with RLS on', async () => {
    // The upgrade path for tables older than v273: a table whose RLS came only from the blob's blocks or the event
    // trigger is off on a trigger-less brain however old it is. A later migration that creates a table without its own
    // RLS block leaves it off here too.
    const { url, conn } = await scratchDatabase();
    try {
      await freshInit(url);
      const all = await tablesWithoutRls(conn);
      expect(all).toEqual([]);
      await conn.unsafe(`DO $$ DECLARE t record; BEGIN
        FOR t IN SELECT c.oid::regclass AS rel FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                  WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity LOOP
          EXECUTE format('ALTER TABLE %s DISABLE ROW LEVEL SECURITY', t.rel);
        END LOOP; END $$`);
      await conn.unsafe(`UPDATE config SET value = $1 WHERE key = 'version'`, [String(v275.version - 1)]);
      expect((await tablesWithoutRls(conn)).length).toBeGreaterThan(100);

      const home = makeHome({ engine: 'postgres', database_url: url });
      homes.push(home);
      const run = await collect(spawnDriver(home, writeSchemaDriver(home, { migrations: [], args: ['--yes', '--non-interactive', '--no-autopilot-install', '--json'] })));
      expect(run.code, run.stderr + run.stdout).toBe(0);
      expect(run.stderr).not.toContain('row-level security is still off');
      expect(await tablesWithoutRls(conn)).toEqual([]);
    } finally {
      await conn.end();
    }
  }, 300_000);

  /** Runs the v275 handler on one reserved session (role, search path) and returns what it wrote to stderr. */
  async function runHandlerAs(conn: ReturnType<typeof postgres>, setup: string): Promise<string> {
    const session = await conn.reserve();
    const stderr: string[] = [];
    const write = process.stderr.write;
    try {
      await session.unsafe(setup);
      const executeRaw = (sql: string, params?: unknown[]) => session.unsafe(sql, params as never[]);
      const transaction = async (fn: (tx: unknown) => Promise<unknown>) => {
        await session.unsafe('BEGIN');
        try {
          const result = await fn({ executeRaw });
          await session.unsafe('COMMIT');
          return result;
        } catch (error) {
          await session.unsafe('ROLLBACK');
          throw error;
        }
      };
      const engine = { kind: 'postgres', executeRaw, transaction };
      process.stderr.write = ((chunk: string) => { stderr.push(String(chunk)); return true; }) as typeof process.stderr.write;
      await v275.handler!(engine as never);
    } finally {
      process.stderr.write = write;
      await session.unsafe('RESET ROLE; RESET search_path');
      session.release();
    }
    return stderr.join('');
  }

  test('v275 skips an exempt table and a table the role cannot protect, and names what is left', async () => {
    const { url, conn } = await scratchDatabase();
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    const noBypass = `gbrain_test_rls_nobypass_${suffix}`;
    const notOwner = `gbrain_test_rls_notowner_${suffix}`;
    try {
      await freshInit(url);
      await conn.unsafe(`ALTER TABLE page_derivation_spend DISABLE ROW LEVEL SECURITY; ALTER TABLE query_cache DISABLE ROW LEVEL SECURITY;
        COMMENT ON TABLE query_cache IS 'GBRAIN:RLS_EXEMPT reason=probe table read by an external reader'`);
      await conn.unsafe(`CREATE ROLE ${noBypass} NOLOGIN NOBYPASSRLS; CREATE ROLE ${notOwner} NOLOGIN BYPASSRLS`);
      for (const role of [noBypass, notOwner]) {
        const stderr = await runHandlerAs(conn, `SET ROLE ${role}`);
        expect(stderr).toContain('v275: row-level security is still off on 1 table(s) (page_derivation_spend)');
        expect(await tablesWithoutRls(conn)).toEqual(['page_derivation_spend']);
      }

      expect(await runHandlerAs(conn, 'SELECT 1')).toBe('');
      expect(await tablesWithoutRls(conn)).toEqual([]);
      const exempt = await conn.unsafe<Array<{ relrowsecurity: boolean }>>(`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.query_cache'::regclass`);
      expect(exempt[0]?.relrowsecurity).toBe(false);
    } finally {
      await conn.end();
      await admin!.unsafe(`DROP ROLE IF EXISTS ${noBypass}`).catch(() => {});
      await admin!.unsafe(`DROP ROLE IF EXISTS ${notOwner}`).catch(() => {});
    }
  }, 300_000);

  test('v275 protects the public table when a same-named table earlier in the search path shadows it', async () => {
    const { url, conn } = await scratchDatabase();
    try {
      await freshInit(url);
      await conn.unsafe(`CREATE SCHEMA shadow; CREATE TABLE shadow.query_cache (LIKE public.query_cache);
        ALTER TABLE shadow.query_cache DISABLE ROW LEVEL SECURITY; ALTER TABLE public.query_cache DISABLE ROW LEVEL SECURITY`);
      expect(await runHandlerAs(conn, 'SET search_path = shadow, public')).toBe('');
      const flags = await conn.unsafe<Array<{ name: string; relrowsecurity: boolean }>>(
        `SELECT n.nspname || '.' || c.relname AS name, c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relname = 'query_cache' ORDER BY 1`);
      expect(flags.map(f => ({ name: f.name, relrowsecurity: f.relrowsecurity }))).toEqual([{ name: 'public.query_cache', relrowsecurity: true }, { name: 'shadow.query_cache', relrowsecurity: true }]);
    } finally {
      await conn.end();
    }
  }, 300_000);

  // Generated by gstack /ship coverage audit (#7625).
  // Value: protects=v275 stops with the typed schema_lock_blocked refusal naming the table when another session holds a
  // lock, changes nothing, and succeeds once the lock is gone; fails_when=the SET LOCAL lock_timeout or the 55P03 mapping
  // is dropped (the upgrade hangs or throws an untyped error); why_new=no test holds a lock against v275; seam=none;
  // no_claim=the blocking-session sample (v275 passes sessions: null) and transaction-pooler behavior
  test('v275 refuses with schema_lock_blocked when another session holds a lock on a table it must protect, and finishes after', async () => {
    const { url, conn } = await scratchDatabase();
    const engine = new PostgresEngine();
    const holder = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
    try {
      await freshInit(url);
      await engine.connect({ database_url: url });
      await conn.unsafe('ALTER TABLE page_derivation_spend DISABLE ROW LEVEL SECURITY');
      const session = await holder.reserve();
      try {
        await session.unsafe('BEGIN; LOCK TABLE page_derivation_spend IN ACCESS SHARE MODE');
        const error = await withEnv({ GBRAIN_SCHEMA_LOCK_TIMEOUT_SECONDS: '1' }, () => v275.handler!(engine).then(() => null, (e: unknown) => e));
        expect(error).toMatchObject({ code: 'schema_lock_blocked', detail: 'v275 on page_derivation_spend' });
        expect(await tablesWithoutRls(conn)).toEqual(['page_derivation_spend']);
      } finally {
        await session.unsafe('ROLLBACK');
        session.release();
      }
      await withEnv({ GBRAIN_SCHEMA_LOCK_TIMEOUT_SECONDS: '1' }, () => v275.handler!(engine));
      expect(await tablesWithoutRls(conn)).toEqual([]);
    } finally {
      await holder.end();
      await engine.disconnect();
      await conn.end();
    }
  }, 300_000);

  test('gbrain repair missing-tables recreates a cache table with RLS on', async () => {
    const { url, conn } = await scratchDatabase();
    const engine = new PostgresEngine();
    try {
      await freshInit(url);
      await engine.connect({ database_url: url });
      for (const table of ['query_cache', 'code_traversal_cache']) {
        await conn.unsafe(`DROP TABLE ${table}`);
        await recreateStep(table)!(engine);
      }
      expect(await presentTables(conn, ['code_traversal_cache', 'query_cache'])).toEqual(['code_traversal_cache', 'query_cache']);
      expect(await tablesWithoutRls(conn)).toEqual([]);

      // Generated by gstack /ship coverage audit (#7625).
      // Value: protects=the real repair apply, which runs the recreate step inside its own transaction and lock timeout,
      // leaves the recreated cache with RLS on; fails_when=protectTables breaks or is skipped when nested in the apply
      // transaction; why_new=the calls above run the step outside any transaction; seam=none;
      // no_claim=the CLI wrapper and preview printing (handler driven through runRepair)
      const home = makeHome({ engine: 'postgres', database_url: url });
      homes.push(home);
      await withEnv({ GBRAIN_HOME: home }, async () => {
        const ctx = { engine, sourceId: 'default', remote: false, dryRun: false, config: { engine: 'postgres', embedding_disabled: true },
          logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext;
        await conn.unsafe('DROP TABLE query_cache');
        const scope = await resolveRepairScope(engine);
        const preview = await runRepair(ctx, missingTablesRepair, scope, { apply: false, explicit: true });
        const applied = await runRepair(ctx, missingTablesRepair, scope, { apply: true, explicit: true, expect: preview.preview_hash });
        expect(applied.outcomes).toMatchObject({ recreated: 1 });
      });
      expect(await presentTables(conn, ['query_cache'])).toEqual(['query_cache']);
      expect(await tablesWithoutRls(conn)).toEqual([]);
    } finally {
      await engine.disconnect();
      await conn.end();
    }
  }, 300_000);
});
