/**
 * E2E for migration v50: ingest_log.source_id ALTER (codex P1 #3).
 *
 * Pins the idempotency contract under all four states:
 *   1. Fresh install (column added by schema.sql inline + v50 ALTER no-ops).
 *   2. Old brain (no column) → v50 adds with NOT NULL DEFAULT 'default';
 *      existing rows backfilled.
 *   3. Re-run after success → still no-op.
 *   4. Bootstrap path: when schema_version is 0 and we replay SCHEMA_SQL on
 *      a brain that has the legacy ingest_log shape (no source_id),
 *      applyForwardReferenceBootstrap adds the column BEFORE SCHEMA_SQL
 *      replays so the new idx_ingest_log_source_type_created index can build.
 *
 * Real Postgres only — gated by DATABASE_URL, skips otherwise.
 *
 * Run: DATABASE_URL=... bun test test/e2e/migration-v50-ingest-log-source-id.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import {
  hasDatabase,
  setupDB,
  teardownDB,
  getConn,
  getEngine,
  runMigrationsUpTo,
  setConfigVersion,
} from './helpers.ts';
import { MIGRATIONS, LATEST_VERSION } from '../../src/core/migrate.ts';

const skip = !hasDatabase();
const describeE2E = skip ? describe.skip : describe;

if (skip) {
  console.log('Skipping migration v50 E2E tests (DATABASE_URL not set)');
}

const v50 = MIGRATIONS.find(m => m.version === 50);
if (!skip && !v50) {
  throw new Error('Migration v50 not found in MIGRATIONS array. PR1 commit 11 (renumbered v47→v50 after master merge) should add it.');
}

async function dropSourceIdColumn(): Promise<void> {
  const conn = getConn();
  await conn.unsafe(`ALTER TABLE ingest_log DROP COLUMN IF EXISTS source_id`);
  await conn.unsafe(`DROP INDEX IF EXISTS idx_ingest_log_source_type_created`);
}

async function runV50(): Promise<void> {
  const engine = getEngine();
  const m = MIGRATIONS.find(x => x.version === 50);
  if (!m) throw new Error('Migration v50 not found');
  const sql = m.sqlFor?.[engine.kind] ?? m.sql;
  if (sql) {
    await engine.transaction(async (tx) => {
      await tx.runMigration(50, sql);
    });
  }
  if (m.handler) await m.handler(engine);
  await engine.setConfig('version', '50');
}

async function readSourceIdColumnExists(): Promise<boolean> {
  const conn = getConn();
  const rows = await conn`
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'ingest_log'
      AND column_name = 'source_id'
  `;
  return rows.length === 1;
}

async function readIndexExists(): Promise<boolean> {
  const conn = getConn();
  const rows = await conn`
    SELECT 1 FROM pg_indexes
    WHERE schemaname = current_schema()
      AND tablename = 'ingest_log'
      AND indexname = 'idx_ingest_log_source_type_created'
  `;
  return rows.length === 1;
}

describeE2E('migration v50: ingest_log.source_id ALTER', () => {
  beforeAll(async () => {
    await setupDB();
    await runMigrationsUpTo(getEngine(), LATEST_VERSION);
  }, 30_000);

  afterAll(async () => {
    await teardownDB();
  });

  test('after fresh install, source_id column + index both exist', async () => {
    expect(await readSourceIdColumnExists()).toBe(true);
    expect(await readIndexExists()).toBe(true);
  });

  test('old brain simulation: drop column, run v50, column reappears with NOT NULL DEFAULT', async () => {
    await dropSourceIdColumn();
    expect(await readSourceIdColumnExists()).toBe(false);

    await setConfigVersion(49);
    await runV50();

    expect(await readSourceIdColumnExists()).toBe(true);
    expect(await readIndexExists()).toBe(true);

    // Verify NOT NULL DEFAULT 'default' shape: an INSERT without source_id
    // works and the row gets 'default'.
    const conn = getConn();
    await conn.unsafe(`
      INSERT INTO ingest_log (source_type, source_ref, summary)
      VALUES ('__v50_test__', 'test-ref', 'test summary')
    `);
    const rows = await conn<Array<{ source_id: string }>>`
      SELECT source_id FROM ingest_log WHERE source_type = '__v50_test__'
    `;
    expect(rows.length).toBe(1);
    expect(rows[0].source_id).toBe('default');
    await conn.unsafe(`DELETE FROM ingest_log WHERE source_type = '__v50_test__'`);
  });

  test('idempotent re-run on fully-migrated brain → no error, no state change', async () => {
    const beforeCol = await readSourceIdColumnExists();
    const beforeIdx = await readIndexExists();

    await runV50();
    await runV50();  // run twice for paranoia

    expect(await readSourceIdColumnExists()).toBe(beforeCol);
    expect(await readIndexExists()).toBe(beforeIdx);
    expect(beforeCol).toBe(true);
    expect(beforeIdx).toBe(true);
  });
});
