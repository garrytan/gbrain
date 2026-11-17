import type { Migration } from './types.ts';
import { PERSISTENCE_FOREGROUND_COMMITTED_INDEX } from '../persistence/schema.ts';
import { buildIndexOnline, migrationNotice } from './helpers.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// #7649: after a restart every write claim's foreground-commit probe (journal.ts
// FOREGROUND_WAITING_ON) starts at sequence 0, and no index served committed
// rows by (worktree, sequence), so on a large request table each claim walked
// every receipt and overran the claim phase. Postgres builds the partial index
// CONCURRENTLY outside a transaction, after dropping an INVALID leftover of an
// interrupted build (the blob omits it); PGLite builds it inline. `gbrain repair
// request-indexes` runs the same helper on a brain whose schema is already
// current. DDL only: no column, no backfill.
export const v276: Migration = {
  version: 276,
  name: 'persistence_foreground_committed_index',
  idempotent: true,
  transaction: false,
  sql: '',
  handler: async engine => {
    await buildIndexOnline(engine, 276, PERSISTENCE_FOREGROUND_COMMITTED_INDEX, { notice: migrationNotice });
  },
};
