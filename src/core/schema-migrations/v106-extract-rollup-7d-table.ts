import type { Migration } from './types.ts';

export const v106: Migration = {
  version: 106,
  name: 'extract_rollup_7d_table',
  // v0.41.23 — Per-day rollup of extract events for fast doctor reads.
  // Audit JSONL at ~/.gbrain/audit/extract-rounds-YYYY-Www.jsonl remains
  // the SOURCE OF TRUTH (forensic, append-only, crash-safe). This DB
  // table is a best-effort cache for doctor's <100ms read budget on
  // heavy brains (per F-OUT-19 dual-write posture, JSONL primary).
  //
  // Per-day rows mean the 7-day window auto-evicts; doctor reads
  // `WHERE day >= CURRENT_DATE - 7`. UPSERT on every audit event
  // serializes via Postgres' INSERT ... ON CONFLICT DO UPDATE.
  //
  // Cycle's purge phase GCs rows older than 30 days (operational buffer
  // beyond the 7-day read window).
  //
  // Slot history: originally claimed v100 in plan; bumped to v104 after
  // v98/v99/v101/v102/v103 master merges; bumped again to v106 after
  // v0.41.22 master merge took v104 (pages_atom_source_hash_idx) and
  // v105 (slug_aliases).
  sql: `
      CREATE TABLE IF NOT EXISTS extract_rollup_7d (
        kind TEXT NOT NULL,
        source_id TEXT NOT NULL,
        day DATE NOT NULL,
        cost_usd REAL NOT NULL DEFAULT 0,
        halt_count INT NOT NULL DEFAULT 0,
        eval_fail_count INT NOT NULL DEFAULT 0,
        eval_pass_count INT NOT NULL DEFAULT 0,
        round_completed_count INT NOT NULL DEFAULT 0,
        rollup_write_failures INT NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (kind, source_id, day)
      );
      CREATE INDEX IF NOT EXISTS idx_extract_rollup_7d_day
        ON extract_rollup_7d (day);
    `,
};
