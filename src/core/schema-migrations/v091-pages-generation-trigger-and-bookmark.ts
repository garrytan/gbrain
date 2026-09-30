import type { Migration } from './types.ts';
import { dropInvalidConcurrentIndex } from './helpers.ts';

export const v091: Migration = {
  version: 91,
  name: 'pages_generation_trigger_and_bookmark',
  // v0.40.3.0 cache invalidation gate. Two columns + a trigger + an
  // index. Wires the document-side staleness signal for the new
  // query_cache two-layer gate.
  //
  //   pages.generation BIGINT NOT NULL DEFAULT 1
  //     — monotonically increasing per-page generation counter. Bumped
  //       by `bump_page_generation_trg` on UPDATE when any content
  //       column is IS DISTINCT FROM. Read by the per-page snapshot
  //       check in query-cache-gate.ts.
  //
  //   query_cache.max_generation_at_store BIGINT NOT NULL DEFAULT 0
  //     — corpus-state bookmark stamped at cache-write time. Read by
  //       the Layer 1 (cheap) gate in query-cache-gate.ts: if
  //       MAX(generation) > stamp, the brain has had a write since
  //       this row was stored, fall through to Layer 2 (per-page).
  //
  //   bump_page_generation_fn() + BEFORE INSERT OR UPDATE trigger
  //     — handles every write path uniformly. INSERT: pages get
  //       generation = COALESCE(MAX(generation) FROM pages, 0) + 1
  //       so the bookmark gate fires for any cache row stored before
  //       the new page existed (codex #4 INSERT coverage fix).
  //       UPDATE: bumps generation only when content columns are
  //       IS DISTINCT FROM — read-time mutations (e.g., last_retrieved_at
  //       from v0.37 Open Collider) intentionally don't bump.
  //
  //     Allow-list (per D6 widened from the original 6-column plan):
  //       body, frontmatter, compiled_truth, timeline, deleted_at,
  //       contextual_retrieval_mode (the v0.40.3.0 wave),
  //       title, type, page_kind, corpus_generation
  //
  //     Provenance fields (ingested_via/ingested_at/source_uri/
  //     source_kind from master's v81) deliberately NOT in the
  //     allow-list — they're channel metadata, not content; re-importing
  //     the same content via a different source shouldn't invalidate
  //     caches. (Codex #6 verify: confirmed putPage at this version
  //     does not treat these as content-bearing.)
  //
  //   CREATE INDEX pages_generation_idx ON pages (generation)
  //     — supports O(log N) MAX(generation) for the Layer 1 bookmark
  //       check. Plain btree (codex #8 confirmed DESC unnecessary —
  //       Postgres backward-scans plain btrees for MAX). CONCURRENTLY
  //       on Postgres so large brains don't lock; PGLite has no
  //       concurrent writers so plain CREATE INDEX is identical.
  //
  // Engine-aware via handler (not multi-statement SQL): Postgres uses
  // CREATE INDEX CONCURRENTLY to avoid the write-blocking SHARE lock on
  // `pages`. CONCURRENTLY refuses to run inside a transaction AND
  // postgres.js's multi-statement `.unsafe()` wraps in an implicit
  // transaction, so we MUST split the work into separate runMigration
  // calls (columns + function + trigger as one transactional batch;
  // CONCURRENTLY index as a separate non-transactional statement).
  // A failed CONCURRENTLY leaves an invalid index with the target name;
  // pre-drop any invalid remnant via pg_index.indisvalid. PGLite has
  // no concurrent writers, so a single multi-statement call with plain
  // CREATE INDEX is safe. Mirrors the v14 pages_updated_at_index handler
  // pattern verbatim.
  //
  // Forward-reference bootstrap: the column + trigger + index land in
  // PGLITE_SCHEMA_SQL CREATE TABLE body so fresh PGLite installs get
  // them without migration replay. REQUIRED_BOOTSTRAP_COVERAGE in
  // test/schema-bootstrap-coverage.test.ts pins the contract.
  idempotent: true,
  sql: '',
  handler: async (engine) => {
    // Columns + trigger function + trigger. Same SQL on both engines —
    // multi-statement is fine for these (transactional is fine for
    // ALTER + CREATE FUNCTION + CREATE TRIGGER).
    const columnsAndTrigger = `
        ALTER TABLE pages ADD COLUMN IF NOT EXISTS generation BIGINT NOT NULL DEFAULT 1;
        ALTER TABLE query_cache ADD COLUMN IF NOT EXISTS max_generation_at_store BIGINT NOT NULL DEFAULT 0;

        CREATE OR REPLACE FUNCTION bump_page_generation_fn() RETURNS trigger AS $func$
        BEGIN
          IF (TG_OP = 'INSERT') THEN
            NEW.generation := COALESCE((SELECT MAX(generation) FROM pages), 0) + 1;
          ELSIF (OLD.compiled_truth IS DISTINCT FROM NEW.compiled_truth)
             OR (OLD.timeline IS DISTINCT FROM NEW.timeline)
             OR (OLD.frontmatter IS DISTINCT FROM NEW.frontmatter)
             OR (OLD.deleted_at IS DISTINCT FROM NEW.deleted_at)
             OR (OLD.contextual_retrieval_mode IS DISTINCT FROM NEW.contextual_retrieval_mode)
             OR (OLD.title IS DISTINCT FROM NEW.title)
             OR (OLD.type IS DISTINCT FROM NEW.type)
             OR (OLD.page_kind IS DISTINCT FROM NEW.page_kind)
             OR (OLD.corpus_generation IS DISTINCT FROM NEW.corpus_generation)
             OR (OLD.content_hash IS DISTINCT FROM NEW.content_hash)
          THEN
            NEW.generation := OLD.generation + 1;
          END IF;
          RETURN NEW;
        END;
        $func$ LANGUAGE plpgsql;

        DROP TRIGGER IF EXISTS bump_page_generation_trg ON pages;
        CREATE TRIGGER bump_page_generation_trg
          BEFORE INSERT OR UPDATE ON pages
          FOR EACH ROW
          EXECUTE FUNCTION bump_page_generation_fn();
      `;
    await engine.runMigration(91, columnsAndTrigger);

    if (engine.kind === 'postgres') {
      await dropInvalidConcurrentIndex(engine, 91, 'pages_generation_idx');
      await engine.runMigration(
        91,
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS pages_generation_idx ON pages (generation);`
      );
    } else {
      await engine.runMigration(
        91,
        `CREATE INDEX IF NOT EXISTS pages_generation_idx ON pages (generation);`
      );
    }
  },
};
