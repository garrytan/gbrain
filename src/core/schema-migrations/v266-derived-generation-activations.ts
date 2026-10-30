import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// GBRA-161 PR 1b: managed generations (docs/architecture/generations.md#managed-sources). A managed activation flips the
// ledger in one coordinated request and marks the items its member requests still have to overwrite or retire
// `pending` (still live); each member request clears its mark, so a crash resumes the rest. The activations table
// records every admitted activation with its members before any of them runs, so members created by an activation
// that never happened are listed (orphan candidates) and never retired automatically. `locator` is a transcript key's
// current file (a moved file keeps its key). New columns default to the old behaviour; no existing row changes. The
// number is a placeholder restamped at the merge slot.
export const v266: Migration = {
  version: 266,
  name: 'derived_generation_activations',
  idempotent: true,
  sql: `
    ALTER TABLE derived_generations ADD COLUMN IF NOT EXISTS locator TEXT;
    ALTER TABLE derived_generations ADD COLUMN IF NOT EXISTS activation_id TEXT;
    ALTER TABLE derived_generation_items ADD COLUMN IF NOT EXISTS pending BOOLEAN NOT NULL DEFAULT false;
    CREATE INDEX IF NOT EXISTS derived_generation_items_pending ON derived_generation_items (generation_id) WHERE pending;
    CREATE TABLE IF NOT EXISTS derived_generation_activations (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      owner_key TEXT NOT NULL,
      expected_generation INTEGER NOT NULL,
      input_pin TEXT,
      item_set_hash TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending','activated')),
      generation_id BIGINT REFERENCES derived_generations(id) ON DELETE SET NULL,
      members JSONB NOT NULL DEFAULT '[]',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS derived_generation_activations_key ON derived_generation_activations (source_id, kind, owner_key, state);
  `,
};
