/**
 * `gbrain repair connector-checkpoints` (#5686): delete connector checkpoint
 * rows and retry pointers that no registered connector source can load and
 * that are older than 7 days. Cleanup only; the upgrade migration's re-key
 * copy never runs here. Rows referenced by a non-terminal request or a
 * recorded pending set are kept. No journal admission: these rows are
 * connector bookkeeping, not canonical pages.
 */
import { deleteOrphanConnectorCheckpoints, orphanConnectorCheckpoints, type OrphanCheckpointRow } from '../persistence/connector-checkpoint-migration.ts';
import type { RepairHandler, RepairItem } from './core.ts';

export const ORPHAN_CHECKPOINT_MIN_AGE_DAYS = 7;

export const connectorCheckpointsRepair: RepairHandler = {
  kind: 'connector-checkpoints',
  publication: 'projection',
  embeds: false,
  // Deletion is idempotent, so every run plans the orphans that remain (the cursor never skips any).
  async plan(engine) {
    const rows = await orphanConnectorCheckpoints(engine, { minAgeDays: ORPHAN_CHECKPOINT_MIN_AGE_DAYS });
    const items: RepairItem[] = rows.map((row, index) => ({ cursor: { phase: row.op === 'managed-connector' ? 0 : 1, id: index + 1 },
      source_id: '(brain)', slug: `${row.op}:${row.fingerprint.slice(0, 12)}`, chars: 0, action: 'delete_orphan',
      change: { from: JSON.stringify(row), to: 'deleted' } }));
    return { items, residuals: {} };
  },
  async apply(ctx, item) {
    const row = JSON.parse(item.change!.from!) as OrphanCheckpointRow;
    const removed = await deleteOrphanConnectorCheckpoints(ctx.engine, [row], { minAgeDays: ORPHAN_CHECKPOINT_MIN_AGE_DAYS });
    return removed.checkpoints + removed.retries > 0;
  },
};
