import type { Migration } from './types.ts';
import { PERSISTENCE_COMMITTED_WATERMARK_INDEX, PERSISTENCE_CONSUMERS_TABLE_SQL } from '../persistence/schema.ts';
import { buildIndexOnline, migrationNotice } from './helpers.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// #6317: `persistence_consumers`, the per-process heartbeat of every full
// persistence consumer on a host (persistence/consumer-heartbeat.ts): a
// resident process defers to the first live full consumer of its host
// (`persistence.single_consumer`), doctor `two_consumers_on_host` names a
// persistent overlap and `writer status --json` lists `host.consumers`. The
// table also lives in `PERSISTENCE_SCHEMA_STATEMENTS` for fresh installs. The
// partial `(worktree_id, completed_at DESC) WHERE state='committed'` index is
// the movement watermark read; Postgres builds it CONCURRENTLY here (the blob
// omits it, like the #5762 sync-run indexes), PGLite inline.
export const v222: Migration = {
  version: 222,
  name: 'persistence_consumers',
  idempotent: true,
  sql: PERSISTENCE_CONSUMERS_TABLE_SQL,
  handler: async engine => {
    await buildIndexOnline(engine, 221, PERSISTENCE_COMMITTED_WATERMARK_INDEX, { notice: migrationNotice });
  },
};
