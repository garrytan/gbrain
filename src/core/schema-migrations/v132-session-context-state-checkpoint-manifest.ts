import type { Migration } from './types.ts';

export const v132: Migration = {
  version: 132,
  name: 'session_context_state_checkpoint_manifest',
  // Cathedral 5 (checkpoint compaction): per-session brain-link manifest
  // banked by the compaction-boundary harvest and rendered into the
  // post-compaction SessionStart pack. A dedicated column because the
  // table's existing jsonb columns are TYPED arrays with validators —
  // there is no free-form bag to extend. Shape: newest-first array of
  // {slug, title, at, n, seg} capped at 20 (dedup-by-slug on append);
  // `seg` is the content hash of the harvested corpus segment, the
  // completion key the OpenClaw assemble poll matches on. DDL-literal
  // '[]'::jsonb default (safe — the double-encode trap bites binds, not
  // DDL); writes bind via $N::text::jsonb in session-state.ts. Row-level
  // 7-day/LRU GC (gcSessionContextState) covers the column for free.
  // Readers are fail-open: pre-v132 brains return an empty manifest.
  // No index (PK-probed only). Keep in sync with src/schema.sql
  // (regenerate schema-embedded.ts via build:schema) and
  // src/core/pglite-schema.ts.
  idempotent: true,
  sql: `
      ALTER TABLE session_context_state ADD COLUMN IF NOT EXISTS checkpoint_manifest JSONB NOT NULL DEFAULT '[]'::jsonb;
    `,
};
