import type { Migration } from './types.ts';
import { PERSISTENCE_EFFECT_PARKED_INDEX_SQL } from '../persistence/effect-schema.ts';
import { dropInvalidConcurrentIndex } from './helpers.ts';

export const v170: Migration = {
  version: 170, name: 'index_parked_persistence_effects', idempotent: true, transaction: false, sql: '',
  handler: async engine => {
    if (engine.kind === 'postgres') await dropInvalidConcurrentIndex(engine, 170, 'persistence_effects_parked');
    await engine.runMigration(170, engine.kind === 'postgres'
      ? PERSISTENCE_EFFECT_PARKED_INDEX_SQL.replace('CREATE INDEX', 'CREATE INDEX CONCURRENTLY')
      : PERSISTENCE_EFFECT_PARKED_INDEX_SQL);
  },
};
