/**
 * Wipe per-test data on a connected PGLite engine without dropping the schema.
 * Used by tests that share one engine across the file (beforeAll) and need a
 * clean slate per test (beforeEach).
 *
 * Why this exists: PGLite WASM cold-start + initSchema() is ~20s on CI runners.
 * Spinning up a fresh engine per test (the prior beforeEach pattern) multiplies
 * that across every test in every file. Sharing one engine and wiping data
 * is two orders of magnitude faster.
 *
 * Canonical block (copy verbatim into PGLite-using test files; enforced by
 * scripts/check-test-isolation.sh rules R3 + R4):
 *
 *   import { PGLiteEngine } from '../src/core/pglite-engine.ts';
 *   import { resetPgliteState } from './helpers/reset-pglite.ts';
 *
 *   let engine: PGLiteEngine;
 *
 *   beforeAll(async () => {
 *     engine = new PGLiteEngine();
 *     await engine.connect({});
 *     await engine.initSchema();
 *   });
 *
 *   afterAll(async () => {
 *     await engine.disconnect();
 *   });
 *
 *   beforeEach(async () => {
 *     await resetPgliteState(engine);
 *   });
 *
 * Why this exact shape:
 *   - `beforeAll` creates one engine per file (~20s schema init paid once).
 *   - `beforeEach` resets user data without re-creating the engine.
 *   - `afterAll(disconnect)` is REQUIRED. The v0.26.4 parallel runner loads
 *     multiple test files into one bun process per shard; without disconnect,
 *     engines leak across file boundaries within a shard process.
 *
 * Implementation:
 *   1. Empty every public table, including `sources` (so tests
 *      that register their own sources don't leak rows into the next test).
 *   2. Re-seed the default source row that pages.source_id's DEFAULT FKs
 *      against. Without this, the next page insert would fail FK validation.
 *   3. Preserve `schema_version` — it carries the migration ledger that
 *      initSchema() populates; wiping it would make migration helpers think
 *      the brain is on v0.
 *
 * Cleanup bypasses row triggers, like TRUNCATE, and resets owned sequences.
 * DELETE avoids recreating every empty table/index's storage on each test.
 * Schemas with truncate/replica triggers or rules, inheritance, or external foreign
 * keys retain TRUNCATE CASCADE semantics. Cleanup is one atomic statement;
 * normal trigger behavior is restored before re-seeding or running tests.
 * Aggregate table/index/TOAST storage over 8 MiB also uses TRUNCATE so deleted
 * rows cannot accumulate unbounded storage across repeated fixture resets.
 * Identifiers are quoted defensively against pathological table names.
 */
import type { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';

// v0.41.21.0: `page_generation_clock` is single-row infrastructure (like
// schema_version) and must survive resetPgliteState. The row is seeded at
// initSchema time by PGLITE_SCHEMA_SQL; TRUNCATEing the table breaks
// page_generation_counter.test.ts AND any test that reads the clock value
// after a reset. Production never truncates the clock table.
const PRESERVE_TABLES = new Set(['schema_version', 'page_generation_clock', 'persistence_brain']);

export async function resetPgliteState(engine: PGLiteEngine): Promise<void> {
  await disposePersistenceConsumer(engine);
  await engine.executeRaw(`DO $reset$
    DECLARE
      tables regclass[];
      targets text;
      storage_bytes bigint;
      target regclass;
      sequence record;
      original_role text := current_setting('session_replication_role');
    BEGIN
      SELECT array_agg(c.oid::regclass), string_agg(format('%I.%I', n.nspname, c.relname), ', '),
          sum(pg_total_relation_size(c.oid))
        INTO tables, targets, storage_bytes
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
          AND c.relname NOT IN (${[...PRESERVE_TABLES].map(t => `'${t}'`).join(', ')});
      IF targets IS NULL THEN RETURN; END IF;
      IF storage_bytes > 8 * 1024 * 1024 OR EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgrelid = ANY(tables)
          AND ((tgtype::int & 32) <> 0 OR tgenabled IN ('A', 'R'))
      ) OR EXISTS (
        SELECT 1 FROM pg_rewrite WHERE ev_class = ANY(tables) AND ev_enabled IN ('A', 'R')
      ) OR EXISTS (
        SELECT 1 FROM pg_constraint WHERE contype = 'f'
          AND confrelid = ANY(tables) AND NOT conrelid = ANY(tables)
      ) OR EXISTS (
        SELECT 1 FROM pg_inherits WHERE inhrelid = ANY(tables) OR inhparent = ANY(tables)
      ) OR EXISTS (
        SELECT 1 FROM pg_event_trigger WHERE evtenabled <> 'D'
      ) OR NOT EXISTS (
        SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolsuper
      ) THEN
        EXECUTE 'TRUNCATE ' || targets || ' RESTART IDENTITY CASCADE';
      ELSE
        PERFORM set_config('session_replication_role', 'replica', true);
        FOREACH target IN ARRAY tables LOOP
          EXECUTE format('DELETE FROM %s', target);
        END LOOP;
        FOR sequence IN
          SELECT n.nspname, c.relname FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            JOIN pg_depend d ON d.objid = c.oid
            WHERE c.relkind = 'S' AND d.refobjid = ANY(tables)
              AND d.classid = 'pg_class'::regclass AND d.refclassid = 'pg_class'::regclass
              AND d.deptype IN ('a', 'i')
        LOOP
          EXECUTE format('ALTER SEQUENCE %I.%I RESTART', sequence.nspname, sequence.relname);
        END LOOP;
        PERFORM set_config('session_replication_role', original_role, true);
      END IF;
      UPDATE persistence_brain SET brain_id = gen_random_uuid(), enabled = false, activated_at = NULL WHERE singleton = 1;
      INSERT INTO sources (id, name, config)
        VALUES ('default', 'default', '{"federated": true}'::jsonb)
        ON CONFLICT (id) DO NOTHING;
    END $reset$`);
}

/** Structural engine slice so the narrow reset works on either engine. */
export interface NarrowResetEngine {
  executeRaw(sql: string): Promise<unknown>;
}

const TABLE_NAME_RE = /^[a-z_][a-z0-9_]*$/;

/**
 * Truncate ONLY the named tables (one TRUNCATE ... RESTART IDENTITY CASCADE
 * statement) — for hot loops where the full-catalog reset is overkill.
 *
 * The table list is EXPLICIT and REQUIRED — there is deliberately no default.
 * A default silently under-truncates the moment a migration adds a table the
 * test writes to; writer.test.ts's 7-table set (pages, links, content_chunks,
 * timeline_entries, tags, raw_data, page_versions) is a reference example,
 * not a default.
 *
 * Constraints:
 *   - Every name must match /^[a-z_][a-z0-9_]*$/ (throws otherwise — names
 *     reach the SQL text; validated names are additionally identifier-quoted).
 *   - Refuses PRESERVE_TABLES (schema_version, page_generation_clock): the
 *     narrow variant preserves everything resetPgliteState preserves.
 *   - CASCADE follows FKs — truncating `sources` also empties pages etc.
 *   - Re-seeds the default source row ONLY when 'sources' is in the list
 *     (mirrors resetPgliteState).
 */
export async function resetPgliteStateNarrow(
  engine: NarrowResetEngine,
  tables: string[],
): Promise<void> {
  if (tables.length === 0) {
    throw new Error(
      'resetPgliteStateNarrow: table list is required and must be non-empty (no default; see doc comment)',
    );
  }
  for (const t of tables) {
    if (!TABLE_NAME_RE.test(t)) {
      throw new Error(
        `resetPgliteStateNarrow: invalid table name ${JSON.stringify(t)} (must match ${TABLE_NAME_RE})`,
      );
    }
    if (PRESERVE_TABLES.has(t)) {
      throw new Error(
        `resetPgliteStateNarrow: refusing to truncate preserved infrastructure table "${t}"`,
      );
    }
  }
  const quoted = tables.map(t => `"${t}"`).join(', ');
  await engine.executeRaw(`TRUNCATE ${quoted} RESTART IDENTITY CASCADE`);
  if (tables.includes('sources')) {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config)
         VALUES ('default', 'default', '{"federated": true}'::jsonb)
         ON CONFLICT (id) DO NOTHING`,
    );
  }
}
