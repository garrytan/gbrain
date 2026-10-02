import type { Migration } from './types.ts';

export const v167: Migration = {
  // A legacy DB-only row can name a fence row as its successor. The fence
  // reconcile deletes and reinserts that row, so a NO ACTION reference made
  // the page fail to reconcile on every cycle. The superseded row stays
  // expired; only the pointer to the replaced row clears.
  version: 167,
  name: 'facts_superseded_by_set_null',
  idempotent: true,
  sql: `
      ALTER TABLE facts DROP CONSTRAINT IF EXISTS facts_superseded_by_fkey;
      ALTER TABLE facts ADD CONSTRAINT facts_superseded_by_fkey
        FOREIGN KEY (superseded_by) REFERENCES facts(id) ON DELETE SET NULL NOT VALID;
      ALTER TABLE facts VALIDATE CONSTRAINT facts_superseded_by_fkey;
    `,
};
