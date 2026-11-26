import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// Swap eligibility (docs/designs/RUST_ENGINE.md "Swap and the way back"): which build of the write-comparison protocol wrote each observed
// row. A writer that keeps the per-session obligation of write samples (src/shadow/write-compare.ts) records WRITE_PROTOCOL 2; a row with NULL
// or a lower number was written by an older build, whose lost samples status cannot prove were all recorded, so criterion 11 counts it as an
// unknown writer path. Additive and nullable, no default and no backfill: adding a nullable column without a default changes only the catalog
// (no table rewrite, no long lock), and an older binary names its insert columns, so it keeps working and leaves the column NULL. The Rust
// store does not copy this table (it is machine-local and starts empty there), so no Rust store format changes.
export const v339: Migration = {
  version: 339,
  name: 'engine_writer_observations_write_protocol',
  // Re-running must be safe: CREATE ... IF NOT EXISTS / ADD COLUMN IF NOT EXISTS.
  idempotent: true,
  sql: `
    ALTER TABLE engine_writer_observations ADD COLUMN IF NOT EXISTS write_protocol INTEGER;
  `,
};
