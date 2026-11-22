import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// GBRA-575 (Discussion #8194): the per-principal private-facts grant axis
// (grants/model.ts PrivateFactsGrant). `granted_sources` lets a remote token or
// OAuth client read facts stamped `visibility = 'private'` in the sources its
// grant names explicitly, without rewriting any fact; `none` (the default
// every existing row reads) keeps them hidden. A constant default, so no row is
// rewritten. Not mirrored into access_tokens.permissions: older binaries read
// only the mirror and keep world-only facts. No schema.sql mirror, like
// private_pages (v280): both columns exist only through migrations, so fresh
// installs and upgrades end with the same column order.
// Provisional number: confirmed at landing.
export const v319: Migration = {
  version: 319,
  name: 'principal_private_facts',
  idempotent: true,
  sql: `
ALTER TABLE access_tokens ADD COLUMN IF NOT EXISTS private_facts TEXT NOT NULL DEFAULT 'none'
  CHECK (private_facts IN ('none', 'granted_sources'));
ALTER TABLE oauth_clients ADD COLUMN IF NOT EXISTS private_facts TEXT NOT NULL DEFAULT 'none'
  CHECK (private_facts IN ('none', 'granted_sources'));
`,
};
