import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// Companies that share an id link automatically (GST-3127, Garry's E2): a "different people or companies" decision keeps
// each member's fingerprint, 32 hex of sha256 over the page's kind, strict name and strong key values (never the values
// themselves), so a rejected pair stays apart after one page is renamed or moved to another source. On a brain with a
// repository the list is also in the decision file (`evidence:`), so a database rebuilt from git keeps it. NULL on
// decisions recorded before this migration until the next sync or gbrain dedupe reconcile fills it from their pages.
export const v330: Migration = {
  version: 330,
  name: 'entity_identity_reviews_evidence',
  idempotent: true,
  sql: `ALTER TABLE entity_identity_reviews ADD COLUMN IF NOT EXISTS evidence JSONB;`,
};
