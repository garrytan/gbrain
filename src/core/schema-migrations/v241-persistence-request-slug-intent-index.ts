import type { Migration } from './types.ts';
import { PERSISTENCE_REQUEST_SLUG_INTENT_INDEX } from '../persistence/schema.ts';
import { buildIndexOnline, migrationNotice } from './helpers.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// #6511 (GBRA-79 wave 16): the page purge's lookup of stored intents for its
// slug (`findRequestsForSlugs`: source, slug, uncompacted rows with an intent)
// had no index and ran as a sequential scan of the request table inside the
// purge's 5 s publication transaction. Postgres builds the partial index
// CONCURRENTLY outside a transaction, after dropping an INVALID leftover (the
// blob omits it); PGLite builds it inline. `gbrain repair request-indexes`
// runs the same helper on a brain whose schema is already current. DDL only:
// no column, no backfill.
export const v241: Migration = {
  version: 241,
  name: 'persistence_request_slug_intent_index',
  idempotent: true,
  transaction: false,
  sql: '',
  handler: async engine => {
    await buildIndexOnline(engine, 241, PERSISTENCE_REQUEST_SLUG_INTENT_INDEX, { notice: migrationNotice });
  },
};
