import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// access_tokens.metadata: host-supplied JSON attached at mint (for example
// { ai, harness, connection_id }) and echoed on write-attribution principals.
// Nullable, no default, no backfill. Like every access_tokens column after the
// original seven, fresh installs get it from this migration (not src/schema.sql),
// so fresh and upgraded brains share column ordinals. The number is restamped at
// the merge slot.
export const v295: Migration = {
  version: 295,
  name: 'access_token_metadata',
  idempotent: true,
  sql: `
    ALTER TABLE access_tokens ADD COLUMN IF NOT EXISTS metadata JSONB;
  `,
};
