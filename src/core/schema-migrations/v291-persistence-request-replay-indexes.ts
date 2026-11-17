import type { Migration } from './types.ts';
import { PERSISTENCE_REQUEST_REPLAY_ID_INDEX, PERSISTENCE_REQUEST_SLUG_SEQUENCE_INDEX } from '../persistence/schema.ts';
import { buildIndexOnline, migrationNotice } from './helpers.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// #8707: the failed-writes repair finds a refused write's replay attempts by
// request id alone and the later requests of its page by source, slug and
// sequence. Neither had an index, so on a large request table each lookup was
// a sequential scan and the preview could not finish. Postgres builds both
// CONCURRENTLY outside a transaction, after dropping an INVALID leftover (the
// blob omits them); PGLite builds them inline. `gbrain repair request-indexes`
// runs the same helper on a brain whose schema is already current. DDL only.
export const v291: Migration = {
  version: 291,
  name: 'persistence_request_replay_indexes',
  idempotent: true,
  transaction: false,
  sql: '',
  handler: async engine => {
    await buildIndexOnline(engine, 291, PERSISTENCE_REQUEST_REPLAY_ID_INDEX, { notice: migrationNotice });
    await buildIndexOnline(engine, 291, PERSISTENCE_REQUEST_SLUG_SEQUENCE_INDEX, { notice: migrationNotice });
  },
};
