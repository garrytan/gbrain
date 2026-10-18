import type { Migration } from './types.ts';
import { buildIndexOnline, migrationNotice } from './helpers.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// Large pages switch-on flip: the segmented-storage gate
// (persistence/writer-versions.ts segmentedGateWriters) judges a marked
// ingest_log row by its version against SEGMENTED_WRITER_FLOOR, because the
// floor rises above releases that already write the segment-reader mark
// (v0.60.290.0 marks its rows but must still hold the switch off). So the gate
// reads the window's marked rows too, not only the unmarked ones v254 indexes.
// ingest_log_marked_idx is the complement of ingest_log_unmarked_idx: each of
// the gate's two importer arms reads its 7-day range from one partial index,
// and together they cover every row once, so the read stays bounded by the
// window instead of scanning the whole log (the only other ingest_log index
// leads with source_id). Built online (CONCURRENTLY on Postgres); an
// interrupted build leaves an INVALID index that the next initSchema drops and
// rebuilds.
export const INGEST_LOG_MARKED_INDEX = {
  name: 'ingest_log_marked_idx',
  table: 'ingest_log',
  sql: 'CREATE INDEX IF NOT EXISTS ingest_log_marked_idx ON ingest_log (created_at) WHERE writer_segment_reader IS TRUE',
};

export const v259: Migration = {
  version: 259,
  name: 'ingest_log_marked_index',
  idempotent: true,
  transaction: false,
  sql: '',
  handler: async engine => {
    await buildIndexOnline(engine, 259, INGEST_LOG_MARKED_INDEX, { notice: migrationNotice });
  },
};
