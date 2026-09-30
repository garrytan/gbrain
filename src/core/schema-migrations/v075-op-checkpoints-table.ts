import type { Migration } from './types.ts';

export const v075: Migration = {
  version: 75,
  name: 'op_checkpoints_table',
  // v0.36+ autonomous-remediation wave (renumbered v67→v75 during master
  // merge — master's v0.36.1.0 calibration + v0.36.3.0 captured v67-v74).
  // Shared checkpoint table for long-running ops (embed, extract, lint,
  // backlinks, reindex, integrity). Pre-fix, each op had its own
  // file-backed checkpoint (or none), which broke on Postgres multi-worker
  // hosts and silently fingerprint-collided across param variations
  // (extract links vs extract timeline shared one file). DB-backed primary;
  // PGLite engine falls back to file-backed at
  // ~/.gbrain/checkpoints/<op>-<fingerprint>.json because it's single-host
  // by construction.
  //
  // Fingerprint = sha8 of canonical-JSON of relevant params per op
  // (chunker_version + embedding_model for embed, mode for extract, etc.).
  // completed_keys are op-defined strings: chunk ids for embed, file paths
  // for extract/lint/backlinks/reindex, page slugs for integrity.
  //
  // GC: cycle's purge phase drops rows older than 7 days.
  idempotent: true,
  sql: `
      CREATE TABLE IF NOT EXISTS op_checkpoints (
        op TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        completed_keys JSONB NOT NULL DEFAULT '[]'::jsonb,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (op, fingerprint)
      );
      CREATE INDEX IF NOT EXISTS op_checkpoints_updated_at_idx
        ON op_checkpoints (updated_at);
    `,
};
