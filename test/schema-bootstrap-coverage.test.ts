/**
 * CI guard: PGLITE_SCHEMA_SQL must not forward-reference state that
 * `applyForwardReferenceBootstrap` doesn't know how to create.
 *
 * Background: gbrain ships an "embedded latest schema" blob
 * (`pglite-schema.ts`) for fast bootstraps, alongside a numbered migration
 * chain (`migrate.ts`) for incremental upgrades. Across 2 years and 6 schema
 * versions, every release that added a column-with-index in the schema blob
 * without a corresponding bootstrap addition has triggered the same wedge
 * incident class (#239, #243, #266, #266, #357, #366, #374, #375, #378,
 * #395, #396).
 *
 * The bootstrap is the structural fix. This test enforces the contract:
 * for every "forward reference" the schema blob makes (FK or indexed column
 * defined later than its reference site, or any column that older brains
 * lack), the bootstrap MUST add enough state so that running the schema
 * blob is replay-safe on a brain that lacks every member of
 * `REQUIRED_BOOTSTRAP_COVERAGE`.
 *
 * **When you add a new schema-blob forward reference:**
 *   1. Extend `applyForwardReferenceBootstrap` in pglite-engine.ts +
 *      postgres-engine.ts to add the new state.
 *   2. Add an entry to `REQUIRED_BOOTSTRAP_COVERAGE` below.
 *   3. This test will pass.
 *
 * If you add a forward reference but skip step 1, this test fails. If you
 * skip step 2, this test passes but the bootstrap silently drifts behind
 * the schema. The eng-review polish notes recommended layered coverage
 * (per-engine integration tests in `test/bootstrap.test.ts` +
 * `test/e2e/postgres-bootstrap.test.ts`) to catch step 2 oversights.
 */

import { test, expect } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

// Tier 3 opt-out: this file tests the bootstrap coverage contract explicitly,
// running applyForwardReferenceBootstrap against fresh PGlite instances. A
// snapshot-loaded engine would skip the bootstrap entirely.
delete process.env.GBRAIN_PGLITE_SNAPSHOT;

// Forward-reference targets that PGLITE_SCHEMA_SQL requires.
// When you add a new one, extend this list AND the bootstrap.
type ForwardReference =
  | { kind: 'table'; name: string }
  | { kind: 'column'; table: string; column: string };

const REQUIRED_BOOTSTRAP_COVERAGE: ForwardReference[] = [
  // Forward-referenced by `pages.source_id REFERENCES sources(id)` and the
  // `INSERT INTO sources (id, name, config) VALUES ('default', ...)` seed.
  { kind: 'table',  name: 'sources' },
  // Forward-referenced by `CREATE INDEX idx_pages_source_id ON pages(source_id)`.
  { kind: 'column', table: 'pages', column: 'source_id' },
  // Forward-referenced by `CREATE INDEX idx_links_source ON links(link_source)`.
  { kind: 'column', table: 'links', column: 'link_source' },
  // Forward-referenced by `CREATE INDEX idx_links_origin ON links(origin_page_id)`.
  { kind: 'column', table: 'links', column: 'origin_page_id' },
  // v0.19+ — forward-referenced by `CREATE INDEX idx_chunks_symbol_name
  // ON content_chunks(symbol_name) WHERE symbol_name IS NOT NULL`.
  { kind: 'column', table: 'content_chunks', column: 'symbol_name' },
  // v0.19+ — forward-referenced by `CREATE INDEX idx_chunks_language
  // ON content_chunks(language) WHERE language IS NOT NULL`.
  { kind: 'column', table: 'content_chunks', column: 'language' },
  // v0.26.5 — forward-referenced by `CREATE INDEX pages_deleted_at_purge_idx
  // ON pages (deleted_at) WHERE deleted_at IS NOT NULL`.
  { kind: 'column', table: 'pages', column: 'deleted_at' },
];

test('applyForwardReferenceBootstrap covers every forward reference declared in REQUIRED_BOOTSTRAP_COVERAGE', async () => {
  const engine = new PGLiteEngine();
  await engine.connect({});
  try {
    await engine.initSchema();
    const db = (engine as any).db;

    // Strip every required forward-reference target so the brain looks like
    // it pre-dates the migrations that introduced these objects. Drop columns
    // before the table-level constraints that depend on them.
    await db.exec(`
      ALTER TABLE pages DROP CONSTRAINT IF EXISTS pages_source_slug_key;
      ALTER TABLE pages ADD CONSTRAINT pages_slug_key UNIQUE (slug);
      DROP INDEX IF EXISTS idx_pages_source_id;
      ALTER TABLE pages DROP COLUMN IF EXISTS source_id;
      DROP TABLE IF EXISTS sources CASCADE;

      DROP INDEX IF EXISTS idx_links_source;
      DROP INDEX IF EXISTS idx_links_origin;
      ALTER TABLE links DROP CONSTRAINT IF EXISTS links_from_to_type_source_origin_unique;
      ALTER TABLE links DROP COLUMN IF EXISTS link_source;
      ALTER TABLE links DROP COLUMN IF EXISTS origin_page_id;

      DROP INDEX IF EXISTS idx_chunks_symbol_name;
      DROP INDEX IF EXISTS idx_chunks_language;
      ALTER TABLE content_chunks DROP COLUMN IF EXISTS symbol_name;
      ALTER TABLE content_chunks DROP COLUMN IF EXISTS language;

      DROP INDEX IF EXISTS pages_deleted_at_purge_idx;
      ALTER TABLE pages DROP COLUMN IF EXISTS deleted_at;
    `);

    // Run bootstrap in isolation (NOT initSchema). This is what we're testing.
    await (engine as any).applyForwardReferenceBootstrap();

    // Assert every required forward-reference target now satisfies the
    // schema-blob's expectations.
    for (const ref of REQUIRED_BOOTSTRAP_COVERAGE) {
      if (ref.kind === 'table') {
        const { rows } = await db.query(
          `SELECT 1 FROM information_schema.tables
           WHERE table_schema = 'public' AND table_name = $1`,
          [ref.name],
        );
        expect(rows.length).toBeGreaterThan(0);
      } else {
        const { rows } = await db.query(
          `SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
          [ref.table, ref.column],
        );
        expect(rows.length).toBeGreaterThan(0);
      }
    }
  } finally {
    await engine.disconnect();
  }
}, 30000);

test('after bootstrap, PGLITE_SCHEMA_SQL replays without crashing on missing forward references', async () => {
  // End-to-end contract: bootstrap → SCHEMA_SQL must succeed even on a brain
  // that lacks every forward-referenced target. This catches the case where
  // REQUIRED_BOOTSTRAP_COVERAGE drifts behind PGLITE_SCHEMA_SQL — if the
  // schema blob added a new index on a column the bootstrap doesn't create,
  // the SCHEMA_SQL exec below would crash even though the per-target asserts
  // above pass.
  const engine = new PGLiteEngine();
  await engine.connect({});
  try {
    await engine.initSchema();
    const db = (engine as any).db;

    await db.exec(`
      ALTER TABLE pages DROP CONSTRAINT IF EXISTS pages_source_slug_key;
      ALTER TABLE pages ADD CONSTRAINT pages_slug_key UNIQUE (slug);
      DROP INDEX IF EXISTS idx_pages_source_id;
      ALTER TABLE pages DROP COLUMN IF EXISTS source_id;
      DROP TABLE IF EXISTS sources CASCADE;
      DROP INDEX IF EXISTS idx_links_source;
      DROP INDEX IF EXISTS idx_links_origin;
      ALTER TABLE links DROP CONSTRAINT IF EXISTS links_from_to_type_source_origin_unique;
      ALTER TABLE links DROP COLUMN IF EXISTS link_source;
      ALTER TABLE links DROP COLUMN IF EXISTS origin_page_id;
      DROP INDEX IF EXISTS pages_deleted_at_purge_idx;
      ALTER TABLE pages DROP COLUMN IF EXISTS deleted_at;
    `);

    // Bootstrap, then schema replay. Either step crashing fails the test.
    const { PGLITE_SCHEMA_SQL } = await import('../src/core/pglite-schema.ts');
    await (engine as any).applyForwardReferenceBootstrap();
    await db.exec(PGLITE_SCHEMA_SQL);
  } finally {
    await engine.disconnect();
  }
}, 30000);
