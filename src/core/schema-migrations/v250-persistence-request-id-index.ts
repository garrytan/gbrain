import type { Migration } from './types.ts';
import { PERSISTENCE_REQUEST_ID_INDEX } from '../persistence/schema.ts';
import { buildIndexOnline, migrationNotice } from './helpers.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// #6757 (wave 18): dream synthesis postprocessing looks up each child's
// committed put_page by request id within the cycle's source. No index served
// that lookup (the unique key leads with the principal), so on a large request
// table it ran as a sequential scan and hit the statement timeout after the
// paid children had run. Postgres builds the index CONCURRENTLY outside a
// transaction, after dropping an INVALID leftover (the blob omits it); PGLite
// builds it inline. `gbrain repair request-indexes` runs the same helper on a
// brain whose schema is already current. DDL only: no column, no backfill.
export const v250: Migration = {
  version: 250,
  name: 'persistence_request_id_index',
  idempotent: true,
  transaction: false,
  sql: '',
  handler: async engine => {
    await buildIndexOnline(engine, 250, PERSISTENCE_REQUEST_ID_INDEX, { notice: migrationNotice });
  },
};
