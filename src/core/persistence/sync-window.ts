/**
 * #5984 admit-ahead: the groups a draining managed sync admits ahead of the
 * group that is publishing (the cursor's `window`).
 *
 * A window group's members name the previous group's last request in their
 * intent (`after`), so groups are claimed and committed in manifest order.
 * #6712 (one page, one fate): a page publishes whatever the fate of the page
 * before it; nothing here cancels a page because another one did not commit.
 * The only order a claim keeps is the wait for a predecessor that is still
 * unfinished. The legacy cancel texts stay so receipts older builds wrote
 * still render as superseded knock-ons (sync-knock-on.ts).
 */
import type { BrainEngine } from '../engine.ts';
import type { WriteRequest } from './model.ts';

/** The window cancel text older builds wrote (no producer since #6712); the legacy knock-on predicate matches it. */
export const WINDOW_CANCEL_MESSAGE = 'An earlier page of the same sync did not commit; this page was not published and is re-frozen after that failure is resolved.';
/** #6402 residual (P4.3): the lane fault a group released under, kept on its rows as `blocked_reason`. */
export type LaneFault = 'lock_timeout' | 'statement_timeout';
export const laneFaultBlockedReason = (fault: LaneFault) => `lane_${fault}` as const;
/** The lane-fault cancel text older builds wrote (no producer since #6712). */
export const laneFaultCancelMessage = (fault: LaneFault) =>
  `An earlier page of the same sync did not commit after ${fault} on its lane group; this page was not published and is re-frozen on the next sync pass.`;
/** The lane fault a recorded legacy cancel names, so `sync status --json` carries it as the failure's detail (#6402 residual). */
export const laneFaultInMessage = (message: string | null | undefined): LaneFault | null =>
  message?.includes(' after lock_timeout on its lane group') ? 'lock_timeout' : message?.includes(' after statement_timeout on its lane group') ? 'statement_timeout' : null;

/** The request a window group waits for, or null for any other request. */
export function windowPredecessor(row: Pick<WriteRequest, 'intent'>): string | null {
  const after = (row.intent as Record<string, unknown> | null | undefined)?.after;
  return typeof after === 'string' ? after : null;
}

type OrderedRow = Pick<WriteRequest, 'intent' | 'request_id' | 'principal_kind' | 'principal_id' | 'sequence'>;
const UNFINISHED = ['queued', 'running', 'recovering'];

/** True for a bulk-sync group member other than its group's head (the head's request ID names the group). */
function groupMember(row: Pick<WriteRequest, 'intent' | 'request_id'>): string | null {
  const group = (row.intent as Record<string, unknown> | null | undefined)?.group;
  return typeof group === 'string' && group !== row.request_id ? group : null;
}

/**
 * The request a claimed row follows, with its state; null when it follows nothing. A group member follows the
 * member before it in its own group (members are admitted consecutively in one transaction, so it is the
 * principal's nearest earlier request of that group); a group head or single request follows its window
 * predecessor `after` ('missing' when that request is gone).
 */
export async function claimedPredecessor(engine: Pick<BrainEngine, 'executeRaw'>, row: OrderedRow): Promise<{ state: string; requestId: string | null } | null> {
  const group = groupMember(row);
  if (group) {
    const [previous] = await engine.executeRaw<{ state: string; request_id: string }>(`SELECT state, request_id::text AS request_id FROM persistence_requests WHERE principal_kind=$1 AND principal_id=$2
      AND sequence<$3 AND intent->>'group'=$4 ORDER BY sequence DESC LIMIT 1`, [row.principal_kind, row.principal_id, row.sequence, group]);
    if (previous) return { state: previous.state, requestId: previous.request_id };
  }
  const after = windowPredecessor(row);
  if (!after) return null;
  const [prior] = await engine.executeRaw<{ state: string }>('SELECT state FROM persistence_requests WHERE principal_kind=$1 AND principal_id=$2 AND request_id=$3::uuid',
    [row.principal_kind, row.principal_id, after]);
  return { state: prior?.state ?? 'missing', requestId: after };
}

/**
 * What a claimed head may do given the request it follows: publish (null) or wait (`'wait'`: release the claim so that
 * request goes first). #6712: a predecessor that ended, committed or not, or was never admitted, lets it publish; only a
 * lane group member whose predecessor member is still unfinished waits (a lane group head runs beside the previous group,
 * and `awaitLaneTurn` orders the commits).
 */
export async function claimedHeadOrder(engine: Pick<BrainEngine, 'executeRaw'>, head: OrderedRow, lane: boolean): Promise<'wait' | null> {
  if (!lane || !groupMember(head)) return null;
  const prior = (await claimedPredecessor(engine, head))?.state ?? null;
  return prior !== null && UNFINISHED.includes(prior) ? 'wait' : null;
}
