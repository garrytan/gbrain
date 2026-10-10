import type { Migration } from './types.ts';
import { PERSISTENCE_COMPACTABLE_INDEX, PERSISTENCE_SYNC_WATERMARK_INDEX } from '../persistence/schema.ts';
import { buildIndexOnline, migrationNotice } from './helpers.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// Two persistence_requests reads a resident `gbrain serve` repeats walked every
// receipt ever written (receipts are permanent; compaction only drops intent):
//
// - The movement watermark (persistence/sync-movement.ts, every minute per
//   managed source) filtered v222's `persistence_requests_committed_watermark`
//   by incarnation and intent kind, so a worktree whose committed receipts are
//   not managed sync receipts was a full walk that detoasted every intent:
//   25 ms at 5k receipts, 220 ms at 50k. `persistence_requests_sync_watermark`
//   keys on (worktree_id, source_incarnation, completed_at DESC) and holds only
//   committed receipts of a `managed_sync_*` kind: one index probe.
// - Receipt compaction's candidate scan (journal.ts `compactWriteReceipts`,
//   every idle maintenance tick) was a sequential scan: 82 ms at 50k receipts.
//   `persistence_requests_compactable` holds the uncompacted terminal receipts
//   by `completed_at`.
//
// Postgres builds both CONCURRENTLY, one at a time, then drops v222's index
// CONCURRENTLY (nothing else reads it); PGLite builds and drops inline. The
// watermark build detoasts each receipt's intent once: 2.3 s at 50k receipts.
// Fresh installs replay v222 on an empty table, so its build and drop cost
// nothing.
export const v223: Migration = {
  version: 223,
  name: 'persistence_serve_loop_indexes',
  idempotent: true,
  sql: '',
  handler: async engine => {
    await buildIndexOnline(engine, 223, PERSISTENCE_SYNC_WATERMARK_INDEX, { notice: migrationNotice });
    await buildIndexOnline(engine, 223, PERSISTENCE_COMPACTABLE_INDEX, { notice: migrationNotice });
    await engine.runMigration(223, `DROP INDEX ${engine.kind === 'postgres' ? 'CONCURRENTLY ' : ''}IF EXISTS persistence_requests_committed_watermark;`);
  },
};
