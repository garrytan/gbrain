import type { Migration } from './types.ts';

export const v044: Migration = {
  version: 44,
  name: 'pages_emotional_weight_recomputed_at',
  idempotent: true,
  // v0.30.1 (Codex X4 / Finding P2): emotional_weight = 0 is a VALID
  // steady-state value (migration v40 default). Indexing WHERE = 0
  // would be a permanent large index over normal data, not a backlog
  // index. The actual backlog predicate is "never recomputed" — for
  // that we need a separate timestamp column. ADD COLUMN with NULL
  // default is metadata-only on PG 11+ and PGLite — instant on tables
  // of any size.
  //
  // The recompute-emotional-weight cycle phase + the new
  // `gbrain backfill emotional_weight` command both stamp this column
  // with NOW() alongside the weight write, so existing rows progress
  // out of the backlog naturally as the cycle runs.
  //
  // Partial index: idx_pages_emotional_weight_pending lives on
  // `(id) WHERE emotional_weight_recomputed_at IS NULL` and is created
  // on first run by the backfill primitive (CONCURRENTLY) rather than
  // here, because schema-time CREATE INDEX isn't CONCURRENTLY-friendly
  // when the SCHEMA_SQL replay runs in a transaction.
  sql: `
      ALTER TABLE pages ADD COLUMN IF NOT EXISTS emotional_weight_recomputed_at TIMESTAMPTZ;
    `,
};
