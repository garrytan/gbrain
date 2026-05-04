/**
 * Tests for migration v35: auto_rls_event_trigger.
 *
 * Verifies that the event trigger auto-enables RLS on newly created tables.
 * Postgres-only (PGLite has no RLS or event trigger support).
 *
 * Run: DATABASE_URL=... bun test test/migration-v35-auto-rls.test.ts
 */

import { describe, test, expect, afterAll } from 'bun:test';

const DATABASE_URL = process.env.GBRAIN_DATABASE_URL || process.env.DATABASE_URL;
const skip = !DATABASE_URL;

const describePostgres = skip ? describe.skip : describe;

if (skip) {
  console.log('Skipping auto-RLS tests (DATABASE_URL not set)');
}

describePostgres('migration v35: auto_rls_event_trigger', () => {
  let sql: any;

  afterAll(async () => {
    // Clean up test table
    if (sql) {
      await sql`DROP TABLE IF EXISTS _test_auto_rls_check`;
      await sql.end();
    }
  });

  test('event trigger exists', async () => {
    const postgres = (await import('postgres')).default;
    sql = postgres(DATABASE_URL!, { prepare: false });

    const triggers = await sql`
      SELECT evtname FROM pg_event_trigger
      WHERE evtname = 'auto_rls_on_create_table'
    `;
    expect(triggers.length).toBe(1);
  });

  test('new tables automatically get RLS enabled', async () => {
    // Create a test table — the event trigger should auto-enable RLS
    await sql`CREATE TABLE _test_auto_rls_check (id serial PRIMARY KEY, val text)`;

    // Check RLS is enabled
    const result = await sql`
      SELECT rowsecurity FROM pg_tables
      WHERE schemaname = 'public' AND tablename = '_test_auto_rls_check'
    `;
    expect(result.length).toBe(1);
    expect(result[0].rowsecurity).toBe(true);
  });

  test('auto_enable_rls function exists', async () => {
    const funcs = await sql`
      SELECT proname FROM pg_proc
      WHERE proname = 'auto_enable_rls'
    `;
    expect(funcs.length).toBe(1);
  });
});
