import type { Migration } from './types.ts';
import { FACT_RELINK_TABLE_SQL, FACT_UNLINKED_INDEX_SQL } from '../facts/relink-schema.ts';
import { dropInvalidConcurrentIndex } from './helpers.ts';

// #5836 `gbrain facts relink`: the per-fact attempt/journal table and the
// keyset index over active unlinked facts; DDL in src/core/facts/relink-schema.ts.
export const v187: Migration = {
  version: 187, name: 'fact_relink_attempts', idempotent: true, transaction: false, sql: '',
  handler: async engine => {
    await engine.runMigration(187, FACT_RELINK_TABLE_SQL);
    if (engine.kind === 'postgres') await dropInvalidConcurrentIndex(engine, 187, 'idx_facts_unlinked_active');
    await engine.runMigration(187, engine.kind === 'postgres'
      ? FACT_UNLINKED_INDEX_SQL.replace('CREATE INDEX', 'CREATE INDEX CONCURRENTLY')
      : FACT_UNLINKED_INDEX_SQL);
  },
};
