import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// GBRA-161 PR 1a: the generation ledger (docs/architecture/generations.md). One live row per
// (source, kind, owner key) records which derived items the current generation owns; superseded
// rows keep the item sets and bounded preimages a restore republishes; a held row records a result
// the primitive would not publish and why. The valve table counts retirements per run window, and the attempts
// table counts terminal failures of one hold identity (three land a held attempts_exhausted row).
// New tables only: no existing row changes. The number is a placeholder restamped at the merge slot.
export const v265: Migration = {
  version: 265,
  name: 'derived_generations',
  idempotent: true,
  sql: `
    CREATE TABLE IF NOT EXISTS derived_generations (
      id BIGSERIAL PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      owner_key TEXT NOT NULL,
      generation INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL CHECK (state IN ('live','held','superseded')),
      run_id TEXT,
      operation_id TEXT NOT NULL,
      hold_id TEXT,
      input_pin TEXT,
      input_size BIGINT,
      completeness JSONB NOT NULL DEFAULT '{}',
      item_set_hash TEXT NOT NULL,
      held_reason TEXT CHECK (held_reason IS NULL OR held_reason IN ('shrunk','oversize','valve','no_proof','fence_absent','attempts_exhausted','segmented_unsupported','tie')),
      held_context JSONB,
      proposal JSONB,
      proposal_bytes INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0,
      superseded_by BIGINT,
      restore_of BIGINT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS derived_generations_one_live ON derived_generations (source_id, kind, owner_key) WHERE state = 'live';
    CREATE UNIQUE INDEX IF NOT EXISTS derived_generations_one_hold ON derived_generations (source_id, kind, owner_key) WHERE state = 'held';
    CREATE INDEX IF NOT EXISTS derived_generations_operation ON derived_generations (operation_id);
    CREATE INDEX IF NOT EXISTS derived_generations_state_created ON derived_generations (state, created_at);
    CREATE TABLE IF NOT EXISTS derived_generation_items (
      generation_id BIGINT NOT NULL REFERENCES derived_generations(id) ON DELETE CASCADE,
      item_key TEXT NOT NULL,
      identity_hash TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('published','retired','revived','kept','adopted')),
      preimage JSONB,
      preimage_bytes INTEGER,
      PRIMARY KEY (generation_id, item_key)
    );
    CREATE INDEX IF NOT EXISTS derived_generation_items_key ON derived_generation_items (item_key);
    CREATE TABLE IF NOT EXISTS derived_generation_valve (
      source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      window_key TEXT NOT NULL,
      retired INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (source_id, kind, window_key)
    );
    CREATE TABLE IF NOT EXISTS derived_generation_attempts (
      hold_id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      owner_key TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      codes JSONB NOT NULL DEFAULT '[]',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS derived_generation_attempts_key ON derived_generation_attempts (source_id, kind, owner_key);
  `,
};
