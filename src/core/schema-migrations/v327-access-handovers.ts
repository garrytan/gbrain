import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// GBRA-582 item 9 (leaver handover, PR 2): one row per `gbrain access member handover`, holding what it changed so it
// can resume after a stop, report its Git publication and be undone once the leaver is enabled again
// (access/handover.ts). `items` keeps each page's, rule's and binding's readers before and after, with its outcome;
// `commits` the folder-rule commits a git-backed source reported. On a brain with no repository the row is the record;
// where git exists the label and rule writers commit first and the row only records outcomes. member_id has no foreign
// key on purpose: a removed member's handover row stays readable. Writes no data; nothing changes on upgrade. No
// schema.sql mirror, like v299.
export const v327: Migration = {
  version: 327,
  name: 'access_handovers',
  idempotent: true,
  sql: `
CREATE TABLE IF NOT EXISTS access_handovers (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL,
  owner_id TEXT,
  plan_hash TEXT NOT NULL,
  choices JSONB NOT NULL DEFAULT '{}'::jsonb,
  items JSONB NOT NULL DEFAULT '[]'::jsonb,
  commits TEXT[] NOT NULL DEFAULT '{}',
  state TEXT NOT NULL CHECK (state IN ('applying', 'publishing', 'applied', 'partial', 'undone')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  undone_at TIMESTAMPTZ,
  undo_of TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS access_handovers_plan_idx ON access_handovers (plan_hash);
CREATE INDEX IF NOT EXISTS access_handovers_member_idx ON access_handovers (member_id, created_at DESC);
DO $rls$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles pr WHERE pg_has_role(current_user, pr.oid, 'USAGE') AND (pr.rolbypassrls OR pr.rolsuper)) THEN
    ALTER TABLE access_handovers ENABLE ROW LEVEL SECURITY;
  END IF;
END $rls$;
`,
};
