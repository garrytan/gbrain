import type { Migration } from './types.ts';
import { PERSISTENCE_REQUEST_DATABASE_SEQUENCE_INDEX, PERSISTENCE_REQUEST_WORKTREE_SEQUENCE_INDEX } from '../persistence/schema.ts';
import { buildIndexOnline, migrationNotice } from './helpers.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// The managed sync idle pin's request probe (passIdleProbe) and the converged
// stamp (readConvergedWatermark) read the newest request of a worktree and the
// newest worktree-less request of a source incarnation. No index led with the
// worktree, so on a busy brain each idle pin read the whole request table.
// Postgres builds both CONCURRENTLY outside a transaction, after dropping an
// INVALID leftover (the blob omits them); PGLite builds them inline. `gbrain
// repair request-indexes` runs the same helper on a brain whose schema is
// already current. DDL only.
export const v316: Migration = {
  version: 316,
  name: 'persistence_request_watermark_indexes',
  idempotent: true,
  transaction: false,
  sql: '',
  handler: async engine => {
    await buildIndexOnline(engine, 316, PERSISTENCE_REQUEST_WORKTREE_SEQUENCE_INDEX, { notice: migrationNotice });
    await buildIndexOnline(engine, 316, PERSISTENCE_REQUEST_DATABASE_SEQUENCE_INDEX, { notice: migrationNotice });
  },
};
