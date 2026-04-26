/**
 * E2E: initSchema() bootstrap order — multi-version upgrade succeeds
 * even when SCHEMA_SQL would otherwise reference columns added by
 * intermediate migrations.
 *
 * The bug this guards against: SCHEMA_SQL targets the latest schema and
 * contains `CREATE INDEX IF NOT EXISTS idx_pages_source_id ON pages(source_id)`.
 * pages.source_id is added by migration v21 (`pages_source_id_composite_unique`).
 * If SCHEMA_SQL ran first against a brain at v4, the index creation aborted
 * with `column "source_id" does not exist` and the upgrade was wedged.
 *
 * The fix: when an existing brain is detected (config.version > 0),
 * runMigrations() is invoked BEFORE SCHEMA_SQL so column-dependent indexes
 * succeed. SCHEMA_SQL then runs as the latest-state enforcer, and a second
 * runMigrations() pass mops up post-SCHEMA_SQL migrations (e.g. the v24
 * RLS-backfill, which references subagent_messages created by SCHEMA_SQL).
 *
 * Skips gracefully when DATABASE_URL is unset, per the CLAUDE.md E2E lifecycle.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { hasDatabase, setupDB, teardownDB, getEngine, getConn, setConfigVersion } from './helpers.ts';
import { LATEST_VERSION } from '../../src/core/migrate.ts';

const SKIP = !hasDatabase();
const describeE2E = SKIP ? describe.skip : describe;

describeE2E('initSchema bootstrap order — recovers from v4-era state', () => {
  beforeAll(async () => {
    await setupDB();
  });
  afterAll(async () => {
    await teardownDB();
  });

  /**
   * Simulate a v4-era brain by dropping the artifacts added by v20-v23.
   * This is intentionally invasive — it replicates what an upgrade from
   * a 9-month-old gbrain looked like when v0.18.0 (multi-source) landed.
   */
  async function rollbackToPreV20(): Promise<void> {
    const conn = getConn();
    await conn.unsafe(`
      -- Drop v23 ledger + page_id rewrite artifacts.
      DROP TABLE IF EXISTS file_migration_ledger CASCADE;
      ALTER TABLE files DROP COLUMN IF EXISTS page_id;

      -- Drop v21 source_id artifacts on pages, restore pre-v21 unique constraint.
      ALTER TABLE pages DROP CONSTRAINT IF EXISTS pages_source_slug_key;
      DROP INDEX IF EXISTS idx_pages_source_id;
      ALTER TABLE pages DROP CONSTRAINT IF EXISTS pages_source_id_fkey;
      ALTER TABLE pages DROP COLUMN IF EXISTS source_id;
      ALTER TABLE pages DROP CONSTRAINT IF EXISTS pages_slug_key;
      ALTER TABLE pages ADD CONSTRAINT pages_slug_key UNIQUE (slug);

      -- Drop v23 source_id on files.
      DROP INDEX IF EXISTS idx_files_source_id;
      ALTER TABLE files DROP CONSTRAINT IF EXISTS files_source_id_fkey;
      ALTER TABLE files DROP COLUMN IF EXISTS source_id;

      -- Drop v20 sources table.
      DROP TABLE IF EXISTS sources CASCADE;
    `);
    await setConfigVersion(4);
  }

  test('pages.source_id is missing after rollback (precondition)', async () => {
    await rollbackToPreV20();
    const conn = getConn();
    const cols = await conn.unsafe<{ column_name: string }[]>(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'pages'
        AND column_name = 'source_id'
    `);
    expect(cols.length).toBe(0);
  });

  test('initSchema recovers an existing v4-era brain to LATEST_VERSION', async () => {
    await rollbackToPreV20();
    const engine = getEngine();

    // The bug: this throws `column "source_id" does not exist` when
    // SCHEMA_SQL ran before runMigrations(). With the fix it succeeds.
    await engine.initSchema();

    const version = await engine.getConfig('version');
    expect(parseInt(version || '0', 10)).toBe(LATEST_VERSION);
  });

  test('post-recovery: pages.source_id + sources("default") exist', async () => {
    const conn = getConn();
    const cols = await conn.unsafe<{ column_name: string }[]>(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'pages'
        AND column_name = 'source_id'
    `);
    expect(cols.length).toBe(1);

    const defaultSource = await conn.unsafe<{ id: string }[]>(
      `SELECT id FROM sources WHERE id = 'default'`,
    );
    expect(defaultSource.length).toBe(1);
  });

  test('initSchema is idempotent on an already-latest brain', async () => {
    const engine = getEngine();
    // Already at LATEST_VERSION from the prior test — re-running must be a no-op.
    await engine.initSchema();

    const version = await engine.getConfig('version');
    expect(parseInt(version || '0', 10)).toBe(LATEST_VERSION);
  });
});
