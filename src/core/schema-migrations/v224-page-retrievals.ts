import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// Retrieval telemetry moves off `pages` (src/core/last-retrieved.ts). The
// per-read `UPDATE pages SET last_retrieved_at` fired seven triggers, wrote a
// new wide heap tuple (never HOT: the column was indexed) with an entry in
// every pages index, and its statement trigger advanced
// page_generation_clock_seq even when the 5-minute throttle matched no row,
// expiring the query-cache bookmark and the get_health and projection
// readiness memos on every read. `page_retrievals` is a narrow side table
// with no foreign key (its KEY SHARE lock would dirty the pages row on every
// bump); a statement trigger removes the rows of hard-deleted pages.
//
// BACKFILL: existing timestamps are copied in one INSERT ... SELECT (a scan of
// pages under ACCESS SHARE; writers are not blocked). The column stays:
// readers take GREATEST of both, so values written by an older binary on the
// same database stay visible. Its index is dropped (no query filters or sorts
// on the column) by the handler: CONCURRENTLY on Postgres, inline on PGLite.
export const v224: Migration = {
  version: 224,
  name: 'page_retrievals',
  idempotent: true,
  sql: `
    CREATE TABLE IF NOT EXISTS page_retrievals (
      page_id           INTEGER PRIMARY KEY,
      last_retrieved_at TIMESTAMPTZ NOT NULL
    );
    CREATE OR REPLACE FUNCTION gbrain_forget_page_retrievals() RETURNS trigger
      LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  DELETE FROM page_retrievals r USING gbrain_deleted_pages d WHERE r.page_id = d.id;
  RETURN NULL;
END $$;
    DROP TRIGGER IF EXISTS pages_forget_retrievals ON pages;
    CREATE TRIGGER pages_forget_retrievals AFTER DELETE ON pages
      REFERENCING OLD TABLE AS gbrain_deleted_pages
      FOR EACH STATEMENT EXECUTE FUNCTION gbrain_forget_page_retrievals();
    INSERT INTO page_retrievals (page_id, last_retrieved_at)
      SELECT id, last_retrieved_at FROM pages WHERE last_retrieved_at IS NOT NULL
      ON CONFLICT (page_id) DO UPDATE SET last_retrieved_at = GREATEST(page_retrievals.last_retrieved_at, EXCLUDED.last_retrieved_at);
  `,
  handler: async engine => {
    await engine.runMigration(224, `DROP INDEX ${engine.kind === 'postgres' ? 'CONCURRENTLY ' : ''}IF EXISTS pages_last_retrieved_at_idx;`);
  },
};
