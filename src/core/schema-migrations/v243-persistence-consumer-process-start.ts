import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(); the fresh-install
// copy of the table (persistence/schema.ts PERSISTENCE_CONSUMERS_TABLE_SQL,
// generated into src/schema.sql) carries the same columns.
export const v243: Migration = {
  version: 243,
  name: 'persistence_consumer_process_start',
  // #6650: a consumer heartbeat row records its process's kernel boot id and
  // start time (`/proc/<pid>/stat` field 22), so a process on the same host can
  // prove the row's owner is dead (its pid is gone, or now belongs to a process
  // that started later) instead of trusting the row for the 30 s liveness
  // window (consumer-heartbeat.ts `consumerProvablyDead`). NULL on rows an
  // older consumer writes; those keep the time-only rule. DDL only: two
  // metadata-only ADD COLUMNs, nothing to backfill.
  idempotent: true,
  sql: `
    ALTER TABLE persistence_consumers ADD COLUMN IF NOT EXISTS boot_id text;
    ALTER TABLE persistence_consumers ADD COLUMN IF NOT EXISTS process_start text;
  `,
};
