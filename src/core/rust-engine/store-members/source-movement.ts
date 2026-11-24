/**
 * `readSourceMovementRows` and `readLiveSyncJobId` (SQL in engine-sql/applied-watermark-reads.ts): one source binding's
 * managed-sync watermark, head request and git hold summary, from the store's request and op-checkpoint records, and the
 * live `sync` job that drains a source, from its job records
 * (rust/crates/gbrain-store/src/persistence/writer_status_queue.rs). Times are ISO text; readSourceMovement reads them
 * as it reads the SQL engines' `Date`s.
 */
import type { SourceMovementBinding, SourceMovementRows } from '../../engine-sql/applied-watermark-reads.ts';
import { storeCall, type StoreMember } from './common.ts';

export const readSourceMovementRows: StoreMember<[binding: SourceMovementBinding], SourceMovementRows> = async (brain, binding) =>
  await storeCall({ member: 'readSourceMovementRows', sourceId: binding.source_id },
    () => brain.sourceMovementRows(binding.source_id, binding.worktree_id, binding.source_incarnation)) as SourceMovementRows;

export const readLiveSyncJobId: StoreMember<[sourceId: string], number | null> = async (brain, sourceId) => {
  const id = await storeCall({ member: 'readLiveSyncJobId', sourceId }, () => brain.liveSyncJobId(sourceId)) as number | string | null;
  return id === null ? null : Number(id);
};
