import type { Migration } from './types.ts';

export const v115: Migration = {
  version: 115,
  name: 'op_checkpoint_paths_append_table',
  // #1794 cathedral: append-only delta storage for op checkpoints. The parent
  // op_checkpoints.completed_keys JSONB was rewritten in full on every flush —
  // O(N^2) write bytes over a 204K-file sync. This child table banks one row
  // per completed path; sync's appendCompleted INSERTs only the delta. The FK
  // ON DELETE CASCADE makes clearOpCheckpoint + the 7-day purge drop children
  // automatically. Created empty so the composite-PK index build is instant;
  // no CONCURRENTLY / transaction:false needed (mirrors v75 op_checkpoints).
  // The PK (op,fingerprint,path) btree's (op,fingerprint) prefix serves every
  // read/delete, so no separate index. Keep in sync with src/schema.sql,
  // src/core/pglite-schema.ts, src/core/schema-embedded.ts.
  idempotent: true,
  sql: `
      CREATE TABLE IF NOT EXISTS op_checkpoint_paths (
        op          TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        path        TEXT NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (op, fingerprint, path),
        CONSTRAINT op_checkpoint_paths_parent_fk
          FOREIGN KEY (op, fingerprint) REFERENCES op_checkpoints (op, fingerprint) ON DELETE CASCADE
      );
    `,
};
