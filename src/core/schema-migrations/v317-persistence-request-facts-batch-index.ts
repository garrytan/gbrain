import type { Migration } from './types.ts';
import { PERSISTENCE_REQUEST_FACTS_BATCH_INDEX } from '../persistence/schema.ts';
import { buildIndexOnline, migrationNotice } from './helpers.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// #9302: managed fact extraction looks a batch up by its batch key before
// admitting it. With no index on the key, each lookup read every extract_facts
// receipt of the principal and decompressed its intent, so the cost grew with
// the journal (14.5 s a call on a small Postgres brain). Postgres builds the
// index CONCURRENTLY outside a transaction, after dropping an INVALID leftover
// (the blob omits it); PGLite builds it inline. `gbrain repair request-indexes`
// runs the same helper on a brain whose schema is already current. DDL only.
export const v317: Migration = {
  version: 317,
  name: 'persistence_request_facts_batch_index',
  idempotent: true,
  transaction: false,
  sql: '',
  handler: async engine => {
    await buildIndexOnline(engine, 317, PERSISTENCE_REQUEST_FACTS_BATCH_INDEX, { notice: migrationNotice });
  },
};
