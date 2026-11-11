import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// GBRA-284 (GST-359 G1 wave 2): personal sources. A row binds a source (a
// person's DM or member source) to the member it belongs to; a source with at
// least one binding is personal. An attested call (x-qm-actor) reads its
// credential's grant minus every personal source not bound to the attested
// member, and a scope read never reads a personal source (access/member-sources.ts).
// The rule only hides inside the grant, so no source becomes readable. source_id
// has no foreign key on purpose: removing and re-adding a source with the same id
// keeps it personal (hidden), never public. Database only, so a repo-less brain
// gets it unchanged. Nothing is rewritten on upgrade; with no binding every read
// is unchanged. No schema.sql mirror, like v286. Numbered on the GBRA-284
// branch; expect a renumber at the merge slot.
export const v299: Migration = {
  version: 299,
  name: 'access_member_sources',
  idempotent: true,
  sql: `
CREATE TABLE IF NOT EXISTS access_member_sources (
  member_id TEXT NOT NULL REFERENCES access_members(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (member_id, source_id)
);
CREATE INDEX IF NOT EXISTS access_member_sources_source_idx ON access_member_sources (source_id);
DO $rls$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles pr WHERE pg_has_role(current_user, pr.oid, 'USAGE') AND (pr.rolbypassrls OR pr.rolsuper)) THEN
    ALTER TABLE access_member_sources ENABLE ROW LEVEL SECURITY;
  END IF;
END $rls$;
`,
};
