import type { Migration } from './types.ts';
import { PERSISTENCE_SYNC_RUN_INDEXES } from '../persistence/schema.ts';
import { buildIndexOnline, migrationNotice } from './helpers.ts';

/**
 * #5762: index the managed sync checkpoint validation. Postgres builds each
 * index CONCURRENTLY, one at a time, after dropping an INVALID leftover (the
 * blob omits them); PGLite builds them inline. `gbrain repair request-indexes`
 * runs the same helper on a brain whose schema is already current.
 */
export const v179: Migration = {
  version: 179,
  name: 'persistence_request_sync_run_indexes',
  idempotent: true,
  transaction: false,
  sql: '',
  handler: async engine => {
    for (const index of PERSISTENCE_SYNC_RUN_INDEXES) {
      await buildIndexOnline(engine, 179, { ...index, table: 'persistence_requests' }, { notice: migrationNotice });
    }
  },
};
