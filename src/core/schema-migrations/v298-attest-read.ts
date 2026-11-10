import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// GST-1158 F3: how an attested call that names sources reads them, a credential
// column beside attest_ops: attest_read 'person' (narrows to the named sources
// but reads as the person) or 'scope' (reads as the scope, and F4: a call that
// names no person is refused). NULL keeps the fail-closed rule (named means
// scope), so no existing credential changes. Readers read it through
// to_jsonb(row), so a schema before it reads as NULL; any other value reads as
// NULL too. Database only, so a repo-less brain gets it unchanged. Nothing is
// rewritten on upgrade. No schema.sql mirror, like v286. Numbered on the
// GBRA-284 branch; expect a renumber at the merge slot.
export const v298: Migration = {
  version: 298,
  name: 'attest_read',
  idempotent: true,
  sql: `
ALTER TABLE access_tokens ADD COLUMN IF NOT EXISTS attest_read TEXT;
ALTER TABLE oauth_clients ADD COLUMN IF NOT EXISTS attest_read TEXT;
`,
};
