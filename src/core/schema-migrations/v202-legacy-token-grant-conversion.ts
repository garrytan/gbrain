import { migrateLegacyTokens } from '../grants/legacy-token.ts';
import { migrationNotice } from './helpers.ts';
import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// Converts every active legacy bearer token still on the JSONB-only grant
// shape (`source_grant IS NULL`) to the unified grant columns in one
// transaction, through the same `migrateLegacyTokens` that
// `gbrain auth rescope --migrate-legacy` runs: no effective grant changes and
// `permissions` stays as the mirror older binaries read. A malformed
// `permissions` value has no faithful column form, so it stays on the legacy
// shape and denies every axis; doctor `legacy_token_grant_shape` lists it.
// Handler-only and rerun-safe (a second run finds no unconverted rows).
export const v202: Migration = {
  version: 202,
  name: 'legacy_token_grant_conversion',
  idempotent: true,
  sql: '',
  handler: async engine => {
    const result = await migrateLegacyTokens(engine, { dryRun: false });
    if (result.migrated.length === 0 && result.skipped.length === 0) return;
    migrationNotice(`  v202: converted ${result.migrated.length} legacy token grant(s) to the unified grant columns; no grant changed.`
      + (result.skipped.length
        ? ` ${result.skipped.length} token(s) with malformed permissions stay denied; gbrain doctor (legacy_token_grant_shape) lists each one with its fix.`
        : '')
      + '\n');
  },
};
