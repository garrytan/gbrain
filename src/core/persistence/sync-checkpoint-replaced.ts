/**
 * #6513 (wave 16 G3.4): a managed-sync checkpoint whose cursor another run of the same source replaced.
 *
 * The replacing run (a rediscovery that retries a recorded failure, a newer sync of the source) re-covers the source from its own
 * discovery, so the superseded checkpoint has nothing left to publish: its refusal is `sync_cursor_replaced` (receipt
 * state `conflict`), it records no managed-sync failure, and the run that awaited it goes on with the winning cursor.
 * A same-run index lag keeps `revision_conflict`, a missing manifest keeps `storage_error`, and a page request whose
 * cursor moved keeps its own `revision_conflict` (its run re-admits it from the current cursor).
 */
import type { WriteRequest } from './model.ts';

export const SYNC_CURSOR_REPLACED = 'sync_cursor_replaced';

/**
 * The classification of a checkpoint whose durable cursor names another run: the refusal code with its receipt message
 * and the diagnostic cause. Null when the cursor still belongs to the checkpoint's run, or the request is not a checkpoint.
 */
export function checkpointCursorReplaced(p: { kind: string; runId: string }, cursorRunId: string | null | undefined, sourceId: string): { code: typeof SYNC_CURSOR_REPLACED; message: string; cause: string } | null {
  if (p.kind !== 'managed_sync_checkpoint' || cursorRunId == null || cursorRunId === p.runId) return null;
  return { code: SYNC_CURSOR_REPLACED, message: 'Another sync run replaced the cursor before this checkpoint published.',
    cause: `Another sync run of ${sourceId} replaced the cursor this checkpoint belongs to, so the checkpoint had nothing left to publish; the replacing run covers the source.` };
}

/** The terminal receipt of a checkpoint another run superseded: nothing to record, nothing to convert. */
export function checkpointSuperseded(pending: { intent: { kind: string } }, done: Pick<WriteRequest, 'error_code'>): boolean {
  return pending.intent.kind === 'managed_sync_checkpoint' && done.error_code === SYNC_CURSOR_REPLACED;
}
