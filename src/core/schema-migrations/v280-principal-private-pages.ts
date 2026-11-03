import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// GBRA-156: the per-principal private-pages grant axis (grants/model.ts
// PrivatePagesGrant). `granted_sources` lets a remote token or OAuth client
// read `visibility: private` pages in the sources its grant names explicitly;
// `none` (the default every existing row reads) keeps them hidden. A constant
// default, so no row is rewritten. Not mirrored into access_tokens.permissions:
// older binaries read only the mirror and keep hiding private pages. No
// schema.sql mirror: like min_trust, both columns exist only through
// migrations, so fresh installs and upgrades end with the same column order.
// Provisional number: renumbered at the merge slot.
export const v280: Migration = {
  version: 280,
  name: 'principal_private_pages',
  idempotent: true,
  sql: `
ALTER TABLE access_tokens ADD COLUMN IF NOT EXISTS private_pages TEXT NOT NULL DEFAULT 'none'
  CHECK (private_pages IN ('none', 'granted_sources'));
ALTER TABLE oauth_clients ADD COLUMN IF NOT EXISTS private_pages TEXT NOT NULL DEFAULT 'none'
  CHECK (private_pages IN ('none', 'granted_sources'));
`,
};
