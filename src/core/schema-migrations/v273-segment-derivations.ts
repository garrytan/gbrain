import type { Migration } from './types.ts';
import { PAGE_SEGMENT_DERIVATIONS_SQL } from '../page-body/schema.ts';
import { runMigrationStatement } from './helpers.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// Wave B PR 4, incremental derivation (wave-b spec 1.2 item 7, 8.1, 8.2):
// - page_segment_derivations: per page, pipeline and manifest occurrence, the
//   segment sha, context hash and pipeline version a derivation ran on, its
//   outcome and a bounded output, with page_derivation_spend and the purge
//   tables beside it (also in both blobs). This migration enables no RLS: the
//   blob's page-body RLS block covers them only when a full initSchema replays
//   it, which `gbrain apply-migrations --yes` does not, and page_derivation_spend
//   was not in that block's list. v275 enables RLS on all four on Postgres.
// - facts.source_window: the conversation window a fact was extracted from,
//   {occurrence_id, window_ordinal, window_text_sha} (page-body/derivations.ts
//   SourceWindow), so an append re-extracts only new windows and deletes only
//   the facts of retired ones. NULL for every existing fact and every fact not
//   extracted from a segmented conversation window. Migration-only, like every
//   facts column (v045 creates the table). Classified as a projection column
//   for write attribution: it locates the fact's source text and is not
//   asserted content, so the attribution trigger is unchanged.
//
// Nothing to backfill. facts_source_window_chk keeps a malformed anchor (a
// double-encoded JSON string included) out; it is added NOT VALID and
// validated in its own statement, so no facts scan runs under the exclusive
// lock of the ALTER; that statement gets the same statement budget and bounded
// lock wait as the migration's SQL (runMigrationStatement). Per-page window reads use the existing
// (source_id, source_markdown_slug, row_num) index.
export const v273: Migration = {
  version: 273,
  name: 'segment_derivations',
  idempotent: true,
  transaction: false,
  sql: `
    ${PAGE_SEGMENT_DERIVATIONS_SQL}
    ALTER TABLE facts ADD COLUMN IF NOT EXISTS source_window JSONB;
    DO $do$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'facts_source_window_chk' AND conrelid = 'facts'::regclass) THEN
        ALTER TABLE facts ADD CONSTRAINT facts_source_window_chk CHECK (source_window IS NULL OR (
          jsonb_typeof(source_window) = 'object'
          AND jsonb_typeof(source_window->'occurrence_id') = 'number'
          AND jsonb_typeof(source_window->'window_ordinal') = 'number'
          AND jsonb_typeof(source_window->'window_text_sha') = 'string'
        )) NOT VALID;
      END IF;
    END $do$;
  `,
  handler: async engine => {
    await runMigrationStatement(engine, 273, 'ALTER TABLE facts VALIDATE CONSTRAINT facts_source_window_chk;');
  },
};
