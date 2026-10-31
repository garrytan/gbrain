import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// GST-359 C1 (GBRA-218, stacked on v274/v275): an attested actor. A trusted
// system's credential (only 'qm' today) may name the person a call serves in
// a header; gbrain maps that person's opaque canonical id to a member through
// access_member_links (system, external_id) and reads as that member.
// external_id is 1-256 visible ASCII characters, compared exactly (no case
// folding); one member may hold several ids. The right to attest is a
// credential column pair: attest_actor (the system name, NULL = none) and
// attest_ops (the operations an attested call may run; NULL = the default
// memory pair). oauth_tokens.grant_type records which OAuth grant issued each
// token, so the right is honoured only for client-credentials tokens (NULL on
// tokens issued before this migration: never attested). Database only, so a
// repo-less brain gets it unchanged. Nothing is rewritten on upgrade.
// No schema.sql mirror: like v274 and v275, these exist only through
// migrations. Provisional number (C1 placeholder): renumbered at the merge slot.
export const v283: Migration = {
  version: 283,
  name: 'qm_actor_links',
  idempotent: true,
  sql: `
CREATE TABLE IF NOT EXISTS access_member_links (
  system TEXT NOT NULL CHECK (system ~ '^[a-z][a-z0-9_-]{0,31}$'),
  external_id TEXT NOT NULL CHECK (length(external_id) BETWEEN 1 AND 256 AND external_id ~ '^[!-~]+$'),
  member_id TEXT NOT NULL REFERENCES access_members(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (system, external_id)
);
CREATE INDEX IF NOT EXISTS access_member_links_member_idx ON access_member_links (member_id);
ALTER TABLE access_tokens ADD COLUMN IF NOT EXISTS attest_actor TEXT;
ALTER TABLE access_tokens ADD COLUMN IF NOT EXISTS attest_ops TEXT[];
ALTER TABLE oauth_clients ADD COLUMN IF NOT EXISTS attest_actor TEXT;
ALTER TABLE oauth_clients ADD COLUMN IF NOT EXISTS attest_ops TEXT[];
ALTER TABLE oauth_tokens ADD COLUMN IF NOT EXISTS grant_type TEXT;
DO $rls$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles pr WHERE pg_has_role(current_user, pr.oid, 'USAGE') AND (pr.rolbypassrls OR pr.rolsuper)) THEN
    ALTER TABLE access_member_links ENABLE ROW LEVEL SECURITY;
  END IF;
END $rls$;
`,
};
