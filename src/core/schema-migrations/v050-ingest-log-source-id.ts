import type { Migration } from './types.ts';

export const v050: Migration = {
  version: 50,
  name: 'ingest_log_source_id',
  // v0.31.2 (codex P1 #3). Renumbered from v47 → v50 after the merge from
  // master picked up v0.31.3's v46 + the takes v2 wave's v48 + v49.
  //
  // facts:absorb logging (commit 13 + doctor's facts_extraction_health
  // check in commit 12) needs source_id on ingest_log so multi-source
  // brains can scope failure counts per source. Pre-fix the column doesn't
  // exist; the schema.sql header even calls it out: "NOTE (v0.18.0 Step 1):
  // ingest_log.source_id is NOT added yet — lands in v17 alongside the
  // sync rewrite." Three years on, sync.ts writes ingest_log without
  // source_id and doctor only checks 'default'. This migration adds the
  // column + backfills existing rows to 'default' via NOT NULL DEFAULT.
  //
  // Idempotent under all states (matches v47's shape):
  //   - Fresh install: ALTER no-ops on IF NOT EXISTS.
  //   - Old brain (no column): ALTER adds it with NOT NULL DEFAULT 'default';
  //     existing rows inherit the default.
  //   - Re-run after success: IF NOT EXISTS short-circuits.
  //
  // Both engines run the same SQL; ingest_log is engine-agnostic.
  sql: `
      ALTER TABLE ingest_log ADD COLUMN IF NOT EXISTS source_id TEXT NOT NULL DEFAULT 'default';

      CREATE INDEX IF NOT EXISTS idx_ingest_log_source_type_created
        ON ingest_log (source_id, source_type, created_at DESC);
    `,
};
