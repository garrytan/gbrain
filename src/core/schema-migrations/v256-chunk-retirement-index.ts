import type { Migration } from './types.ts';
import { buildIndexOnline, migrationNotice } from './helpers.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// Segmented page storage (Wave B PR 2) follow-up:
// - content_chunks_occurrence_generation_idx serves the projection's chunk
//   retirement (page-body/projection.ts STALE_CHUNKS_SQL: hasStaleChunks and
//   each bounded retire batch) and occurrencesWithoutChunks. Retirement walks a
//   page's occurrences on it (one probe each), reads each live occurrence's
//   newest generation at or below the live one from it, and returns only the
//   rows below that generation (or of an occurrence no longer live). The earlier
//   statement tested every chunk row of the page with a per-row subquery for a
//   newer duplicate, which read every newer row of the page (on
//   content_chunks_generation_idx) or every row of the occurrence (on
//   content_chunks_occurrence_idx) for each row: 2.2M buffers to select one
//   batch on a 26 MB page half rewritten by a replace and 420k to find nothing
//   on a 100 MB page, against 1.8k and 3.8k on this index.
// - Not partial: a promotion's deferred inline rows (occurrence_id and
//   body_generation NULL) are retired from the same index, as one range at the
//   end of the page's entries. Built online (CONCURRENTLY on Postgres; writes
//   to content_chunks keep running); an interrupted build leaves an INVALID
//   index that the next initSchema drops and rebuilds.
const CONTENT_CHUNKS_OCCURRENCE_GENERATION_INDEX = {
  name: 'content_chunks_occurrence_generation_idx',
  table: 'content_chunks',
  sql: 'CREATE INDEX IF NOT EXISTS content_chunks_occurrence_generation_idx ON content_chunks (page_id, occurrence_id, body_generation)',
};

export const v256: Migration = {
  version: 256,
  name: 'chunk_retirement_index',
  idempotent: true,
  transaction: false,
  sql: '',
  handler: async engine => {
    await buildIndexOnline(engine, 255, CONTENT_CHUNKS_OCCURRENCE_GENERATION_INDEX, { notice: migrationNotice });
  },
};
