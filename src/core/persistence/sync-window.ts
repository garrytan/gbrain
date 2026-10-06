/**
 * #5984 admit-ahead: the groups a draining managed sync admits ahead of the
 * group that is publishing (the cursor's `window`).
 *
 * A window group's members name the previous group's last request in their
 * intent (`after`). The per-worktree FIFO claim makes a window group claimable
 * only once every earlier request is final, so at claim time that request is
 * either committed (the group publishes) or not (an earlier page failed or was
 * cancelled). In the second case the group is cancelled here, so no page
 * publishes after an earlier page of the same sync failed. Publication
 * validation re-checks the same predecessor inside the transaction.
 */
import type { BrainEngine } from '../engine.ts';
import { completeWrite, lockCounters } from './journal.ts';
import { isTerminal, principalKey, requestPrincipal, type Principal, type WriteRequest } from './model.ts';

export const WINDOW_CANCEL_MESSAGE = 'An earlier page of the same sync did not commit; this page was not published and is re-frozen after that failure is resolved.';

/** The request a window group waits for, or null for any other request. */
export function windowPredecessor(row: Pick<WriteRequest, 'intent'>): string | null {
  const after = (row.intent as Record<string, unknown> | null | undefined)?.after;
  return typeof after === 'string' ? after : null;
}

/**
 * Whether a window group may still publish: its predecessor committed, or, for a lane group (`intent.lane`),
 * is still publishing, since the lane commits only after it (sync-lanes.ts `awaitLaneTurn`). A predecessor
 * that ended without committing, or is missing, never lets it publish.
 */
export async function windowPredecessorAllows(engine: Pick<BrainEngine, 'executeRaw'>, row: Pick<WriteRequest, 'intent' | 'principal_kind' | 'principal_id'>): Promise<boolean> {
  const after = windowPredecessor(row);
  if (!after) return true;
  const [prior] = await engine.executeRaw<{ state: string }>('SELECT state FROM persistence_requests WHERE principal_kind=$1 AND principal_id=$2 AND request_id=$3::uuid',
    [row.principal_kind, row.principal_id, after]);
  if (prior?.state === 'committed') return true;
  return typeof (row.intent as Record<string, unknown> | null | undefined)?.lane === 'string' && ['queued', 'running'].includes(prior?.state ?? '');
}

/** Whether the predecessor of a window group committed (true for requests outside a window). */
export async function windowPredecessorCommitted(engine: Pick<BrainEngine, 'executeRaw'>, row: Pick<WriteRequest, 'intent' | 'principal_kind' | 'principal_id'>): Promise<boolean> {
  const after = windowPredecessor(row);
  if (!after) return true;
  const [prior] = await engine.executeRaw<{ state: string }>('SELECT state FROM persistence_requests WHERE principal_kind=$1 AND principal_id=$2 AND request_id=$3::uuid',
    [row.principal_kind, row.principal_id, after]);
  return prior?.state === 'committed';
}

/**
 * Cancels a claimed window group whose predecessor did not commit: the claimed
 * head and its still-queued members. Returns the settled rows, or null when the
 * group may publish.
 */
export async function cancelOrphanedWindowGroup(engine: BrainEngine, head: WriteRequest): Promise<WriteRequest[] | null> {
  if (await windowPredecessorCommitted(engine, head)) return null;
  const group = typeof head.intent?.group === 'string' ? head.intent.group : head.request_id;
  const members = await engine.executeRaw<WriteRequest>(`SELECT * FROM persistence_requests WHERE worktree_id=$1::uuid AND intent->>'group'=$2
    AND state='queued' AND id<>$3::uuid ORDER BY sequence`, [head.worktree_id, group, head.id]);
  return cancelRows(engine, [head, ...members]);
}

/** The sync side's cancellation of the window after a failed page: every member nobody claimed yet. */
export async function cancelWindow(engine: BrainEngine, window: Array<Array<{ requestId: string }>>, principal: Principal): Promise<void> {
  const ids = window.flat().map(member => member.requestId);
  if (!ids.length) return;
  const rows = await engine.executeRaw<WriteRequest>(`SELECT * FROM persistence_requests WHERE principal_kind=$1 AND principal_id=$2
    AND request_id=ANY($3::uuid[]) AND state='queued' ORDER BY sequence`, [principal.kind, principal.id, ids]);
  await cancelRows(engine, rows);
}

/**
 * #5984 lanes: after a drain's lane tasks settled, cancels its lane run's still-queued rows, in manifest order,
 * whose predecessor ended without committing (a lane that saw its predecessor go back to the queue releases its
 * group, which the window cancellation had skipped while it was claimed). The consumer's FIFO claim cancels the
 * same rows later (`cancelOrphanedWindowGroup`); this settles them before the drain reports.
 */
export async function cancelOrphanedLaneRows(engine: BrainEngine, run: string): Promise<void> {
  const rows = await engine.executeRaw<WriteRequest>(`SELECT * FROM persistence_requests WHERE state='queued' AND intent->>'lane'=$1 ORDER BY sequence`, [run]);
  for (const row of rows) {
    const after = windowPredecessor(row);
    if (!after) continue;
    const [prior] = await engine.executeRaw<{ state: string }>('SELECT state FROM persistence_requests WHERE principal_kind=$1 AND principal_id=$2 AND request_id=$3::uuid',
      [row.principal_kind, row.principal_id, after]);
    if (prior && ['failed', 'conflict', 'cancelled'].includes(prior.state)) await cancelRows(engine, [row]);
  }
}

/** Cancels unpublished rows (queued, or claimed with the given token) with the window reason. */
export async function cancelRows(engine: BrainEngine, rows: WriteRequest[]): Promise<WriteRequest[]> {
  const settled: WriteRequest[] = [];
  for (const row of rows) {
    const done = await engine.transaction(async tx => {
      await lockCounters(tx, ['brain', principalKey(requestPrincipal(row)), ...(row.worktree_id ? [`worktree:${row.worktree_id}`] : [])]);
      const [current] = await tx.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE id=$1::uuid FOR UPDATE', [row.id]);
      if (!current || isTerminal(current) || current.execution_token !== row.execution_token || current.publication_started || current.recovery) return current ?? null;
      return completeWrite(tx, current, 'cancelled', {}, { code: 'cancelled', message: WINDOW_CANCEL_MESSAGE });
    });
    if (done) settled.push(done);
  }
  return settled;
}
