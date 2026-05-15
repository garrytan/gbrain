/**
 * E2E test for PostgresEngine forward-reference bootstrap.
 *
 * Codex caught that `test/e2e/helpers.ts:74` uses the standalone
 * `db.initSchema()` from `src/core/db.ts`, which only runs SCHEMA_SQL and
 * never calls runMigrations(). A test using that helper would NOT exercise
 * `PostgresEngine.initSchema()`'s reordered path, producing false-positive
 * coverage. This test deliberately bypasses the standard helper and
 * instantiates `PostgresEngine` directly, calling `engine.initSchema()` so
 * the bootstrap → SCHEMA_SQL → runMigrations sequence runs end-to-end.
 *
 * Covers issues #366, #375, #378 — Postgres-side wedges where pre-v0.18
 * brains crashed on `column "source_id" does not exist`.
 *
 * NOTE: snapshot-based historical state simulation is out of scope for this
 * wave (would require maintaining historical schema dumps). The test
 * mutates a fresh-LATEST brain to a pre-v0.18 shape; codex flagged this as
 * approximate. Acceptable here because the bootstrap's contract is narrow:
 * "given a brain that lacks the specific forward-references, initSchema
 * produces a brain at LATEST." The test exercises exactly that contract.
 *
 * Run: DATABASE_URL=postgresql://... bun run test:e2e test/e2e/postgres-bootstrap.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { LATEST_VERSION } from '../../src/core/migrate.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL;

describe.skipIf(skip)('PostgresEngine forward-reference bootstrap (E2E)', () => {
  let engine: PostgresEngine;

  beforeAll(async () => {
    engine = new PostgresEngine();
    await engine.connect({ database_url: DATABASE_URL! });
  }, 30_000);

  afterAll(async () => {
    await engine.disconnect();
  });

  test('PostgresEngine.initSchema applies bootstrap → SCHEMA_SQL → migrations on pre-v0.18 brain', async () => {
    // First call: bring the test DB to LATEST shape so we have something to mutate.
    await engine.initSchema();

    // Clear data from prior tests in the suite. Adding a UNIQUE(slug)
    // constraint below would fail if multi-source fixtures left rows with
    // duplicate slugs across sources (which is valid under the composite
    // UNIQUE this test is undoing).
    const conn = (engine as any).sql;
    await conn.unsafe(`TRUNCATE pages, content_chunks, links, tags, raw_data, timeline_entries, page_versions, ingest_log RESTART IDENTITY CASCADE`);

    // Mutate to pre-v0.18 shape: drop source_id and the sources table.
    // The advisory lock is released between initSchema calls, so this
    // direct DDL won't deadlock.
    await conn.unsafe(`
      ALTER TABLE pages DROP CONSTRAINT IF EXISTS pages_source_slug_key;
      ALTER TABLE pages ADD CONSTRAINT pages_slug_key UNIQUE (slug);
      DROP INDEX IF EXISTS idx_pages_source_id;
      ALTER TABLE pages DROP COLUMN IF EXISTS source_id CASCADE;
      DROP TABLE IF EXISTS sources CASCADE;
    `);
    await engine.setConfig('version', '20');

    // The path under test: full PostgresEngine.initSchema() including the
    // bootstrap call, SCHEMA_SQL replay, and runMigrations chain.
    await engine.initSchema();

    expect(await engine.getConfig('version')).toBe(String(LATEST_VERSION));

    // Verify the forward-referenced column exists after upgrade.
    const colCheck = await conn`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'pages'
        AND column_name = 'source_id'
    `;
    expect(colCheck).toHaveLength(1);

    // Verify the default source row was seeded.
    const srcCheck = await conn`SELECT id FROM sources WHERE id = 'default'`;
    expect(srcCheck).toHaveLength(1);
  });

  test('PostgresEngine.initSchema is idempotent on a brain already at LATEST', async () => {
    // Fresh-LATEST brain. Calling initSchema again must not error and must
    // not regress the version.
    await engine.initSchema();
    expect(await engine.getConfig('version')).toBe(String(LATEST_VERSION));
  });

  test('rewound-brain: pre-v0.18 files + pre-v60 oauth_clients all bootstrap → SCHEMA_SQL → LATEST', async () => {
    // Coverage for the bootstrap-gap fix wave that closes #974 + #1018 +
    // the column-half of #820. This single test exercises both new probe paths
    // together — same pattern as commit 336597c's rewound-brain E2E for
    // the v39-v41 wave.
    //
    // The test asserts: from a brain that lacks every newly-probed column,
    // PostgresEngine.initSchema() (bootstrap → SCHEMA_SQL → runMigrations)
    // produces a brain at LATEST_VERSION with each column present and
    // index built. If any branch is misordered (e.g. files/oauth_clients
    // ALTER fires before sources is created), the FK ADD CONSTRAINT crashes
    // here and the test fails loud.
    await engine.initSchema(); // start clean

    const conn = (engine as any).sql;
    await conn.unsafe(`TRUNCATE pages, content_chunks, links, tags, raw_data, timeline_entries, page_versions, ingest_log RESTART IDENTITY CASCADE`);

    // Strip the columns added in this fix-wave's coverage. The pages.source_id
    // strip is intentionally repeated so the fix-wave columns and the original
    // pages bootstrap path are exercised together — proves ordering is right.
    await conn.unsafe(`
      ALTER TABLE pages DROP CONSTRAINT IF EXISTS pages_source_slug_key;
      ALTER TABLE pages ADD CONSTRAINT pages_slug_key UNIQUE (slug);
      DROP INDEX IF EXISTS idx_pages_source_id;
      ALTER TABLE pages DROP COLUMN IF EXISTS source_id CASCADE;


      DROP INDEX IF EXISTS idx_files_page_id;
      DROP INDEX IF EXISTS idx_files_source_id;
      ALTER TABLE files DROP COLUMN IF EXISTS source_id CASCADE;
      ALTER TABLE files DROP COLUMN IF EXISTS page_id CASCADE;

      -- v0.34.1 (v60+v61) columns missing from the original bootstrap.
      DROP INDEX IF EXISTS idx_oauth_clients_source_id;
      DROP INDEX IF EXISTS idx_oauth_clients_federated_read;
      ALTER TABLE oauth_clients DROP COLUMN IF EXISTS source_id CASCADE;
      ALTER TABLE oauth_clients DROP COLUMN IF EXISTS federated_read CASCADE;

      -- sources MUST go last so the column drops above don't trip CASCADE
      -- on FKs we're about to recreate via bootstrap.
      DROP TABLE IF EXISTS sources CASCADE;
    `);
    await engine.setConfig('version', '17');

    // The path under test: full PostgresEngine.initSchema() through bootstrap,
    // SCHEMA_SQL replay, and runMigrations. Any ordering bug crashes here.
    await engine.initSchema();

    expect(await engine.getConfig('version')).toBe(String(LATEST_VERSION));

    // Verify each previously-missing column now exists.
    const expectations: Array<{ table: string; column: string }> = [
      { table: 'files', column: 'source_id' },
      { table: 'files', column: 'page_id' },
      { table: 'oauth_clients', column: 'source_id' },
      { table: 'oauth_clients', column: 'federated_read' },
    ];
    for (const exp of expectations) {
      const rows = await conn`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = ${exp.table}
          AND column_name = ${exp.column}
      `;
      expect(rows).toHaveLength(1);
    }

    // Verify the indexes that were the original wedge surface are present.
    const indexes: string[] = [
      'idx_files_page_id',
      'idx_files_source_id',
      'idx_oauth_clients_source_id',
      'idx_oauth_clients_federated_read',
    ];
    for (const idx of indexes) {
      const rows = await conn`
        SELECT indexname FROM pg_indexes
        WHERE schemaname = current_schema()
          AND indexname = ${idx}
      `;
      expect(rows).toHaveLength(1);
    }
  }, 60_000);
});
