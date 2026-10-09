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
 * #6252: whether an earlier member of this row's bulk group ended without committing (failed, cancelled or
 * conflicted). Such a row must not publish: a group commits in manifest order, so its pages after a member that
 * did not commit are cancelled and re-frozen once that member is resolved, never written ahead of it.
 */
export async function earlierGroupMemberFailed(engine: Pick<BrainEngine, 'executeRaw'>, row: Pick<WriteRequest, 'intent' | 'request_id' | 'worktree_id' | 'sequence'>): Promise<boolean> {
  const group = (row.intent as Record<string, unknown> | null | undefined)?.group;
  if (typeof group !== 'string' || group === row.request_id || !row.worktree_id) return false;
  const failed = await engine.executeRaw(`SELECT 1 FROM persistence_requests WHERE worktree_id=$1::uuid AND intent->>'group'=$2
    AND sequence<$3 AND state IN ('failed','cancelled','conflict') LIMIT 1`, [row.worktree_id, group, row.sequence]);
  return failed.length > 0;
}

/** Cancels a claimed window group (outside lanes) that may not publish; null when it may (`claimedHeadOrder`). */
export async function cancelOrphanedWindowGroup(engine: BrainEngine, head: WriteRequest): Promise<WriteRequest[] | null> {
  const order = await claimedHeadOrder(engine, head, false);
  return order === 'wait' ? null : order;
}

type OrderedRow = Pick<WriteRequest, 'intent' | 'request_id' | 'principal_kind' | 'principal_id' | 'sequence'>;
const ENDED_UNCOMMITTED = ['failed', 'conflict', 'cancelled'];

/** True for a bulk-sync group member other than its group's head (the head's request ID names the group). */
function groupMember(row: Pick<WriteRequest, 'intent' | 'request_id'>): string | null {
  const group = (row.intent as Record<string, unknown> | null | undefined)?.group;
  return typeof group === 'string' && group !== row.request_id ? group : null;
}

/**
 * The state of the request a claimed row must follow; null when it follows nothing. A group member follows the
 * member before it in its own group (members are admitted consecutively in one transaction, so it is the
 * principal's nearest earlier request of that group); a group head or single request follows its window
 * predecessor `after` ('missing' when that request is gone). A member's `after` names only the previous group,
 * so a member claimed on its own (released mid-group, then claimed again) is ordered by this, never by `after`.
 */
export async function claimedPredecessorState(engine: Pick<BrainEngine, 'executeRaw'>, row: OrderedRow): Promise<string | null> {
  const group = groupMember(row);
  if (group) {
    const [previous] = await engine.executeRaw<{ state: string }>(`SELECT state FROM persistence_requests WHERE principal_kind=$1 AND principal_id=$2
      AND sequence<$3 AND intent->>'group'=$4 ORDER BY sequence DESC LIMIT 1`, [row.principal_kind, row.principal_id, row.sequence, group]);
    if (previous) return previous.state;
  }
  const after = windowPredecessor(row);
  if (!after) return null;
  const [prior] = await engine.executeRaw<{ state: string }>('SELECT state FROM persistence_requests WHERE principal_kind=$1 AND principal_id=$2 AND request_id=$3::uuid',
    [row.principal_kind, row.principal_id, after]);
  return prior?.state ?? 'missing';
}

/**
 * What a claimed head may do given the request it follows (`claimedPredecessorState`): publish (null), wait
 * (`'wait'`: release the claim so that request goes first), or nothing: its group's claimed head and
 * still-queued later members are cancelled and returned. Outside lanes any uncommitted predecessor cancels
 * (the per-worktree FIFO claim means it is final). A lane group head may run while the previous group still
 * publishes (`awaitLaneTurn` orders the commits and `laneFallback` settles a failed predecessor), but a lane
 * group member waits for the member before it and is cancelled when that member ended without committing.
 */
export async function claimedHeadOrder(engine: BrainEngine, head: WriteRequest, lane: boolean): Promise<WriteRequest[] | 'wait' | null> {
  const prior = await claimedPredecessorState(engine, head);
  if (prior === null || prior === 'committed') return null;
  if (lane && !groupMember(head)) return null;
  if (lane && !ENDED_UNCOMMITTED.includes(prior)) return 'wait';
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
 * same rows later (`claimedHeadOrder`); this settles them before the drain reports. A group member is judged by
 * the member before it (`claimedPredecessorState`), so a member released mid-group is cancelled with its group. With
 * `settleMs`, it also waits (up to that long) for orphans the consumer already claimed under the FIFO to finish
 * cancelling, so a blocked drain never reports one of them still running.
 */
export async function cancelOrphanedLaneRows(engine: BrainEngine, run: string, settleMs = 0): Promise<void> {
  const started = Date.now();
  for (;;) {
    const rows = await engine.executeRaw<WriteRequest>(`SELECT * FROM persistence_requests WHERE state IN ('queued','running') AND intent->>'lane'=$1 ORDER BY sequence`, [run]);
    let unsettled = false;
    for (const row of rows) {
      // In manifest order, so a row cancelled here is the uncommitted predecessor the next row sees.
      if (!ENDED_UNCOMMITTED.includes(await claimedPredecessorState(engine, row) ?? '')) continue;
      // A running orphan is one the consumer claimed under the FIFO after the lanes closed; it cancels it itself.
      if (row.state === 'running') unsettled = true;
      else await cancelRows(engine, [row]);
    }
    if (!unsettled || Date.now() - started >= settleMs) return;
    await new Promise(resolve => setTimeout(resolve, 50));
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
