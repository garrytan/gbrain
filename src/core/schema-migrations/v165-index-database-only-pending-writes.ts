import type { Migration } from './types.ts';
import { PERSISTENCE_DATABASE_PENDING_INDEX_SQL } from '../persistence/schema.ts';
import { dropInvalidConcurrentIndex } from './helpers.ts';

export const v165: Migration = {
  version: 165, name: 'index_database_only_pending_writes', idempotent: true, transaction: false, sql: '',
  handler: async engine => {
    if (engine.kind === 'postgres') await dropInvalidConcurrentIndex(engine, 165, 'persistence_requests_database_pending');
    await engine.runMigration(165, engine.kind === 'postgres'
      ? PERSISTENCE_DATABASE_PENDING_INDEX_SQL.replace('CREATE INDEX', 'CREATE INDEX CONCURRENTLY')
      : PERSISTENCE_DATABASE_PENDING_INDEX_SQL);
  },
};
