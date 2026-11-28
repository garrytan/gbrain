import type { Migration } from './types.ts';
import { PERSISTENCE_COMMITTED_SEEN_INDEX, PERSISTENCE_REQUEST_CREATED_INDEX } from '../persistence/schema.ts';
import { buildIndexOnline, migrationNotice } from './helpers.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// #10605: the segmented-storage gate's evidence read bounds the request table on
// created_at (admitters) and on COALESCE(published_at, completed_at) of committed
// receipts (consumers). Neither had an index, so each read scanned every receipt and
// its TOAST, pushing search data out of a small database's cache. Postgres builds both
// CONCURRENTLY outside a transaction, after dropping an INVALID leftover; PGLite builds
// them inline. `gbrain repair request-indexes` runs the same helper on a brain whose
// schema is already current. DDL only: no column, no backfill.
export const v344: Migration = {
  version: 344,
  name: 'persistence_request_window_indexes',
  idempotent: true,
  transaction: false,
  sql: '',
  handler: async engine => {
    await buildIndexOnline(engine, 344, PERSISTENCE_REQUEST_CREATED_INDEX, { notice: migrationNotice });
    await buildIndexOnline(engine, 344, PERSISTENCE_COMMITTED_SEEN_INDEX, { notice: migrationNotice });
  },
};
