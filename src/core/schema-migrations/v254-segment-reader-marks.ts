import type { Migration } from './types.ts';
import { buildIndexOnline, migrationNotice } from './helpers.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// Wave B segment-reader marks (fix lane B, B3/B6): the segmented-storage gate
// (page-body/limits.ts segmentedWriterBlockers) must see every binary that
// writes without understanding segmented pages. A version string cannot say
// so (a branch build and a release of the same VERSION stamp the same text),
// so each write path of a binary with segment readers sets a mark, and a
// binary older than this migration, which does not know the column, leaves it
// NULL in every row it inserts:
// - persistence_requests.admitter_segment_reader / consumer_segment_reader:
//   managed writes, next to the v178 version stamps (migration-only, like them);
// - ingest_log.writer_version / writer_host_id / writer_segment_reader: the
//   row `gbrain import`, sync, connectors and the facts paths log per run
//   (engine logIngest), which unmanaged writes leave behind; also in
//   schema.sql's CREATE TABLE, appended, so fresh and upgraded brains share
//   the column order;
// - persistence_consumers.segment_reader: the heartbeat of a resident serve,
//   sync, jobs, autopilot or mcp process (also in PERSISTENCE_CONSUMERS_TABLE_SQL).
// Never backfilled: a past writer cannot be proven to read segments, so rows
// from before this migration count as unmarked for the gate's 7-day window.
// ingest_log_unmarked_idx keeps the gate's read off a scan of the whole log:
// partial on the unmarked rows (every row before this migration, then only
// what an older binary writes), built online (CONCURRENTLY on Postgres).
export const INGEST_LOG_UNMARKED_INDEX = {
  name: 'ingest_log_unmarked_idx',
  table: 'ingest_log',
  sql: 'CREATE INDEX IF NOT EXISTS ingest_log_unmarked_idx ON ingest_log (created_at) WHERE writer_segment_reader IS NOT TRUE',
};

export const v254: Migration = {
  version: 254,
  name: 'segment_reader_marks',
  idempotent: true,
  transaction: false,
  sql: `
    ALTER TABLE persistence_requests ADD COLUMN IF NOT EXISTS admitter_segment_reader boolean;
    ALTER TABLE persistence_requests ADD COLUMN IF NOT EXISTS consumer_segment_reader boolean;
    ALTER TABLE persistence_consumers ADD COLUMN IF NOT EXISTS segment_reader boolean;
    ALTER TABLE ingest_log ADD COLUMN IF NOT EXISTS writer_version text;
    ALTER TABLE ingest_log ADD COLUMN IF NOT EXISTS writer_host_id uuid;
    ALTER TABLE ingest_log ADD COLUMN IF NOT EXISTS writer_segment_reader boolean;
  `,
  handler: async engine => {
    await buildIndexOnline(engine, 253, INGEST_LOG_UNMARKED_INDEX, { notice: migrationNotice });
  },
};
