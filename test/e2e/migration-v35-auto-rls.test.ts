/**
 * E2E tests for Phase 4D RLS posture.
 *
 * v35 is now a deprecated no-op. v39 removes the legacy auto-RLS event trigger,
 * disables RLS on GBrain-owned service-role tables, and stamps the explicit
 * GBRAIN:RLS_POSTURE comment. Postgres-only — PGLite has no RLS/event trigger
 * surface and that no-op is asserted in test/migrate.test.ts.
 *
 * Run: DATABASE_URL=... bun test test/e2e/migration-v35-auto-rls.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { hasDatabase, setupDB, teardownDB, getConn, getEngine, runMigrationsUpTo } from './helpers.ts';
import { LATEST_VERSION } from '../../src/core/migrate.ts';

const skip = !hasDatabase();
const describeE2E = skip ? describe.skip : describe;

if (skip) {
  console.log('Skipping RLS-posture E2E tests (DATABASE_URL not set)');
}

describeE2E('migration v39: service-role-only RLS posture', () => {
  beforeAll(async () => {
    await setupDB();
    await runMigrationsUpTo(getEngine(), LATEST_VERSION);
  });

  afterAll(async () => {
    const conn = getConn();
    await conn.unsafe(`DROP TABLE IF EXISTS _test_v39_zero_policy`);
    await conn.unsafe(`DROP TABLE IF EXISTS _test_v39_documented_disabled`);
    await teardownDB();
  });

  test('legacy auto-RLS event trigger/function are absent', async () => {
    const conn = getConn();
    const triggers = await conn`
      SELECT evtname FROM pg_event_trigger
      WHERE evtname = 'auto_rls_on_create_table'
    `;
    expect(triggers.length).toBe(0);

    const funcs = await conn`
      SELECT proname FROM pg_proc
      WHERE proname = 'auto_enable_rls'
    `;
    expect(funcs.length).toBe(0);
  });

  test('GBrain-owned tables are RLS-disabled and documented', async () => {
    const conn = getConn();
    const rows = await conn`
      SELECT
        c.relname AS table_name,
        c.relrowsecurity AS rowsecurity,
        COALESCE(obj_description(c.oid, 'pg_class'), '') AS comment
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
        AND c.relname IN ('pages', 'content_chunks', 'links', 'tags', 'raw_data', 'timeline_entries', 'page_versions', 'ingest_log', 'config', 'files', 'access_tokens', 'mcp_request_log')
      ORDER BY c.relname
    `;
    expect(rows.length).toBeGreaterThanOrEqual(10);
    for (const row of rows) {
      expect(row.rowsecurity).toBe(false);
      expect(row.comment).toContain('GBRAIN:RLS_POSTURE service-role-only');
    }
  });

  test('no zero-policy RLS trapdoors remain after migrations', async () => {
    const conn = getConn();
    const trapdoors = await conn`
      SELECT c.relname AS table_name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN (
        SELECT polrelid, count(*) AS policy_count
        FROM pg_policy
        GROUP BY polrelid
      ) p ON p.polrelid = c.oid
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
        AND c.relrowsecurity
        AND COALESCE(p.policy_count, 0) = 0
      ORDER BY c.relname
    `;
    expect(trapdoors.map((r: any) => r.table_name)).toEqual([]);
  });

  test('doctor fails a newly introduced zero-policy RLS table', async () => {
    const conn = getConn();
    await conn`CREATE TABLE _test_v39_zero_policy (id serial PRIMARY KEY)`;
    await conn`ALTER TABLE _test_v39_zero_policy ENABLE ROW LEVEL SECURITY`;

    const cliCwd = import.meta.dir + '/../..';
    const result = Bun.spawnSync({
      cmd: ['bun', 'run', 'src/cli.ts', 'doctor', '--json'],
      cwd: cliCwd,
      env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL!, GBRAIN_DATABASE_URL: process.env.DATABASE_URL! },
      timeout: 20_000,
    });
    const stdout = new TextDecoder().decode(result.stdout);
    const parsed = JSON.parse(stdout);
    const rls = parsed.checks.find((c: any) => c.name === 'rls');
    expect(rls.status).toBe('fail');
    expect(rls.message).toContain('_test_v39_zero_policy');
    expect(rls.message).toContain('RLS enabled with ZERO policies');
    expect(result.exitCode).toBe(1);
  });

  test('doctor accepts a disabled table with explicit GBRAIN:RLS_POSTURE comment', async () => {
    const conn = getConn();
    await conn`CREATE TABLE _test_v39_documented_disabled (id serial PRIMARY KEY)`;
    await conn`ALTER TABLE _test_v39_documented_disabled DISABLE ROW LEVEL SECURITY`;
    await conn`COMMENT ON TABLE _test_v39_documented_disabled IS 'GBRAIN:RLS_POSTURE service-role-only; RLS disabled; MCP/app bearer-token authorization is the security boundary.'`;
    await conn`DROP TABLE IF EXISTS _test_v39_zero_policy`;

    const cliCwd = import.meta.dir + '/../..';
    const result = Bun.spawnSync({
      cmd: ['bun', 'run', 'src/cli.ts', 'doctor', '--json'],
      cwd: cliCwd,
      env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL!, GBRAIN_DATABASE_URL: process.env.DATABASE_URL! },
      timeout: 20_000,
    });
    const stdout = new TextDecoder().decode(result.stdout);
    const parsed = JSON.parse(stdout);
    const rls = parsed.checks.find((c: any) => c.name === 'rls');
    expect(rls.status).not.toBe('fail');
    expect(rls.message).toContain('No zero-policy RLS trapdoors');
  });
});
