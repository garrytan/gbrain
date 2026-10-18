import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(); the fresh-install
// copy in src/schema.sql carries the same table.
//
// Large pages A7 (src/core/extraction-watermark.ts): one row per page and
// extraction pipeline. The watermark (UTF-8 byte offset into the extracted
// body plus the sha256 of the body up to it, under a pipeline version) lets
// the next extraction of an appended page read only the appended tail.
// `input_truncated` is the durable receipt of an extraction that read only
// part of its input (the head, the newest window of a long tail, or a page
// skipped as too large); doctor's `extraction_input_truncated` reads it.
// Hashes, offsets and counts only: no page text is stored. Rows go with
// their page (ON DELETE CASCADE). DDL only, nothing to backfill: a page with
// no row falls back to today's behavior and records the receipt.
export const v247: Migration = {
  version: 247,
  name: 'page_extraction_state',
  idempotent: true,
  sql: `
    CREATE TABLE IF NOT EXISTS page_extraction_state (
      page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
      pipeline TEXT NOT NULL CHECK (pipeline IN ('facts_backstop','extract_atoms','conversation_facts')),
      pipeline_version INTEGER NOT NULL,
      watermark_bytes BIGINT CHECK (watermark_bytes >= 0),
      watermark_sha256 TEXT,
      input_truncated JSONB,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (page_id, pipeline)
    );
    CREATE INDEX IF NOT EXISTS page_extraction_state_truncated_idx
      ON page_extraction_state (pipeline, page_id) WHERE input_truncated IS NOT NULL;
  `,
};
