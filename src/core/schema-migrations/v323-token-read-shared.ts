import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// GST-2898 A/D: the per-key "also read every shared source, now and later"
// switch (grants/model.ts PrincipalGrant.readShared). The switch is on only
// while read_shared_revision equals the row's grant_revision: every grant
// write by this build re-stamps it, and a grant write by an older build bumps
// grant_revision without touching it, so the switch turns itself off instead
// of re-widening a key an older build narrowed. Nullable with no default, so
// no row is rewritten and every existing key and client keeps its read set.
// Not mirrored into access_tokens.permissions: older builds ignore it and read
// less. No schema.sql mirror: like private_pages (v280), both columns exist
// only through migrations, so fresh installs and upgrades end with the same
// column order.
export const v323: Migration = {
  version: 323,
  name: 'token_read_shared',
  idempotent: true,
  sql: `
ALTER TABLE access_tokens ADD COLUMN IF NOT EXISTS read_shared_revision INTEGER NULL;
ALTER TABLE oauth_clients ADD COLUMN IF NOT EXISTS read_shared_revision INTEGER NULL;
`,
};
