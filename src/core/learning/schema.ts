/**
 * Learning ledger storage DDL (nightly learning PR 1): one canonical copy used by the learning_items schema migration
 * and, through scripts/build-schema.ts FRAGMENTS, by fresh-install DDL.
 *
 * Pointers only. A row names what a cycle learned by its target row (kind, target_table, target_id) and never copies
 * the target's text or visibility: the learned read view (src/core/learning/read.ts) joins each pointer to its live
 * target under the caller's filters, so a forgotten, purged, deleted or relabelled target hides its item. No foreign
 * key to the target: a hard delete leaves a dangling pointer that reads as gone, and the derive pass prunes it.
 * The unique key keeps overlapping hourly cycles from recording one change twice.
 */

export const LEARNING_ITEMS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS learning_items (
  id                BIGSERIAL PRIMARY KEY,
  run_id            UUID NOT NULL,
  source_id         TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind              TEXT NOT NULL CHECK (kind IN ('fact_added','you_wrote','promise_found','page_filled','conflict_found','duplicate_to_confirm')),
  target_table      TEXT NOT NULL CHECK (target_table IN ('facts','decide_proposals','open_loops','page_versions','pages')),
  target_id         BIGINT NOT NULL,
  subject_slug      TEXT,
  subject_source_id TEXT,
  prior_revision    TEXT,
  state             TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','kept','undone','answered','expired')),
  shown_at          TIMESTAMPTZ,
  decided_at        TIMESTAMPTZ,
  decided_by        TEXT,
  member_id         TEXT,
  CONSTRAINT learning_items_target_uniq UNIQUE (kind, target_table, target_id)
);
CREATE INDEX IF NOT EXISTS learning_items_source_state_created_idx ON learning_items (source_id, state, created_at);
DO $rls$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles r WHERE pg_has_role(current_user, r.oid, 'USAGE') AND (r.rolbypassrls OR r.rolsuper)) THEN
    ALTER TABLE learning_items ENABLE ROW LEVEL SECURITY;
  END IF;
END $rls$;
`;
