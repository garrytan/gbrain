import type { Migration } from './types.ts';

export const v028: Migration = {
  version: 28,
  name: 'cathedral_ii_chunk_fts_backfill',
  // v0.20.0 Cathedral II Layer 3 (1b) — backfill content_chunks.search_vector
  // for rows inserted before v27 ran. The v27 trigger only fires on
  // INSERT/UPDATE, so every chunk that existed before upgrade has a NULL
  // search_vector and would match zero rows in the new chunk-grain
  // searchKeyword. Compute the vector in-place here so upgraded brains
  // have full keyword coverage the moment v28 commits — no need to wait
  // for every page to get touched by sync.
  //
  // Direct vector compute (not UPDATE chunk_text = chunk_text to trigger):
  //   - UPDATE-to-same-value fires the trigger unconditionally on Postgres
  //     even if no column value changes, so trigger-based backfill DOES
  //     work, but writing the vector directly is cheaper (single pass
  //     instead of trigger overhead per row).
  //   - Idempotent via `WHERE search_vector IS NULL` — re-running v28
  //     after a partial run picks up only the remaining NULL rows.
  //
  // On a 20K-chunk brain: ~2-3s total. No blocking concerns: chunks are
  // append-only in steady state; the UPDATE takes a row lock per chunk
  // briefly while computing the tsvector.
  sql: `
      UPDATE content_chunks
      SET search_vector =
        setweight(to_tsvector('english', COALESCE(doc_comment, '')), 'A') ||
        setweight(to_tsvector('english', COALESCE(symbol_name_qualified, '')), 'A') ||
        setweight(to_tsvector('english', COALESCE(chunk_text, '')), 'B')
      WHERE search_vector IS NULL;
    `,
};
