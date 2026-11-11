import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// GST-1158 (F10a): an operator-declared email on a member, so the operator can
// find the member when linking a trusted system's canonical id
// (gbrain access member link --qm <id> --email <addr>). The operator still makes
// every link; nothing links or changes an email from an attested call. Stored
// case-folded (trimmed, lower-case ASCII) by src/core/access/members.ts, unique
// per brain when set, NULL for every existing member, and cleared when a member
// is removed. Database only, so a repo-less brain gets it unchanged. Nothing is
// rewritten on upgrade. No schema.sql mirror: like v282 and v286, it exists only
// through migrations. Provisional number: renumbered at the merge slot.
export const v301: Migration = {
  version: 301,
  name: 'member_email',
  idempotent: true,
  sql: `
ALTER TABLE access_members ADD COLUMN IF NOT EXISTS email TEXT
  CHECK (email IS NULL OR (length(email) <= 254 AND email ~ '^[^@[:space:]]+@[^@[:space:]]+$'));
CREATE UNIQUE INDEX IF NOT EXISTS access_members_email_key ON access_members (email);
`,
};
