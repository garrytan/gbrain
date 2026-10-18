/**
 * #6643: a managed-sync page request that ended without committing only because another request of the same sync did
 * not commit (a knock-on), told apart from a page that really failed.
 *
 * #6712 (one page, one fate) retired every producer: no page is cancelled or refused for another page's failure any
 * more. What stays is the legacy predicate over receipts older builds wrote: such a receipt published nothing, so the
 * terminal classifier renders it superseded and a resumed cursor that meets one re-freezes its entry in place
 * (sync-run.ts `refreezeInPlace`).
 *
 * Older cancellers recorded why and which request they depended on in the receipt's `error_detail` (`origin:
 * 'sync_knock_on'`), which outlives receipt compaction. Receipts written before #6643 carry no marker; they are matched
 * by the exact messages their producers wrote, and nothing else: an operator's cancel ("Cancelled before
 * publication."), an authority or restore cancel, and a compacted receipt with no message are never knock-ons.
 */
import type { WriteRequest } from './model.ts';

export const SYNC_KNOCK_ON_ORIGIN = 'sync_knock_on';
export type KnockOnReason = 'group_member' | 'window_predecessor' | 'predecessor_never_admitted' | 'lane_fault' | 'window_cancelled'
  | 'suffix_cancelled' | 'bulk_group' | 'window_dropped';
export interface KnockOnDetail { origin: typeof SYNC_KNOCK_ON_ORIGIN; reason: KnockOnReason; root_request_id: string | null }

/** The marker older cancellers stamped (no producer since #6712); legacy fixtures build it. */
export const knockOnDetail = (reason: KnockOnReason, rootRequestId: string | null | undefined): KnockOnDetail =>
  ({ origin: SYNC_KNOCK_ON_ORIGIN, reason, root_request_id: rootRequestId ?? null });

/** The dependency validation refusal (`revision_conflict`) a page gets when an earlier page of its run did not commit. */
export const EARLIER_PAGE_REFUSAL_MESSAGE = 'An earlier page of this sync did not commit.';
/** The cursor fence refusal; its `error_detail` says which of #6643's three causes it was (sync-prepare.ts `cursorFenceRefusal`). */
export const CURSOR_CHANGED_REFUSAL_MESSAGE = 'The accepted sync cursor changed before publication.';
/** `error_detail.origin` of a cursor fence refusal that is not a knock-on (`run_replaced`, `outside_fence`). */
export const SYNC_CURSOR_FENCE_ORIGIN = 'sync_cursor_fence';
export type CursorFenceCause = 'run_replaced' | 'window_dropped' | 'outside_fence';
/** The cause a cursor fence refusal recorded, or null (a receipt from before #6643, or another refusal). */
export function cursorFenceCause(detail: unknown): CursorFenceCause | null {
  const cause = (detail as { cause?: unknown } | null)?.cause;
  return cause === 'run_replaced' || cause === 'window_dropped' || cause === 'outside_fence' ? cause : null;
}
/** The bulk group publisher's cancel of the members after one that did not commit (group-publish.ts). */
export const BULK_GROUP_CANCEL_MESSAGE = 'An earlier page of the same bulk sync group failed; this page was not published and is re-frozen after that failure is resolved.';

/**
 * The exact messages pre-#6643 knock-on producers stored, for receipts without the typed marker. The window, lane-fault
 * and never-admitted texts are sync-window.ts's own (`WINDOW_CANCEL_MESSAGE`, `laneFaultCancelMessage`, both
 * never-admitted cancels); the parity test pins this list to those producers.
 */
export const LEGACY_KNOCK_ON_CANCEL_MESSAGES: readonly string[] = [
  'An earlier page of the same sync did not commit; this page was not published and is re-frozen after that failure is resolved.',
  'An earlier page of the same sync did not commit after lock_timeout on its lane group; this page was not published and is re-frozen on the next sync pass.',
  'An earlier page of the same sync did not commit after statement_timeout on its lane group; this page was not published and is re-frozen on the next sync pass.',
  BULK_GROUP_CANCEL_MESSAGE,
];
/** SQL LIKE patterns of the never-admitted cancels, whose text names request ids. */
export const LEGACY_KNOCK_ON_CANCEL_PATTERNS: readonly string[] = [
  'Its predecessor request % was never admitted; this page was not published and is re-frozen on the next sync pass.',
  'The first page of its group (request %) was cancelled because its predecessor request % was never admitted; this page was not published and is re-frozen on the next sync pass.',
];
/** Whether `message` matches a LIKE pattern whose only wildcard is `%` (at least one character, as the producers wrote ids there). */
function matchesLegacyPattern(message: string, pattern: string): boolean {
  const parts = pattern.split('%');
  if (!message.startsWith(parts[0]!) || !message.endsWith(parts.at(-1)!)) return false;
  let at = parts[0]!.length;
  for (const part of parts.slice(1, -1)) {
    const found = message.indexOf(part, at + 1);
    if (found < 0) return false;
    at = found + part.length;
  }
  return message.length - parts.at(-1)!.length > at;
}

const SYNC_PAGE_KINDS = new Set(['managed_sync_import', 'managed_sync_delete']);

/** The typed marker a receipt carries, or null. */
export function knockOnOf(detail: unknown): KnockOnDetail | null {
  const d = detail as Partial<KnockOnDetail> | null;
  if (!d || typeof d !== 'object' || d.origin !== SYNC_KNOCK_ON_ORIGIN || typeof d.reason !== 'string') return null;
  return { origin: SYNC_KNOCK_ON_ORIGIN, reason: d.reason as KnockOnReason, root_request_id: typeof d.root_request_id === 'string' ? d.root_request_id : null };
}

/** Whether a terminal message is one a pre-#6643 knock-on producer wrote. */
export function legacyKnockOnMessage(state: string, code: string | null | undefined, message: string | null | undefined): boolean {
  if (!message) return false;
  if (state === 'cancelled') return code === 'cancelled' && (LEGACY_KNOCK_ON_CANCEL_MESSAGES.includes(message) || LEGACY_KNOCK_ON_CANCEL_PATTERNS.some(pattern => matchesLegacyPattern(message, pattern)));
  return (state === 'conflict' || state === 'failed') && code === 'revision_conflict' && message === EARLIER_PAGE_REFUSAL_MESSAGE;
}

/**
 * Whether a sync page request ended without committing only because another request of its sync did not commit. It
 * must be terminal, uncommitted, recovery-free and never have started publication; a compacted receipt counts only by
 * its typed marker (its intent and message are gone, so the page kind is taken from the marker's producer).
 */
export function isSyncKnockOn(row: Pick<WriteRequest, 'state' | 'error_code' | 'error_message' | 'error_detail' | 'recovery' | 'publication_started' | 'intent'>): boolean {
  if (!['cancelled', 'failed', 'conflict'].includes(row.state) || row.recovery || row.publication_started) return false;
  const kind = (row.intent as Record<string, unknown> | null | undefined)?.kind;
  if (kind != null && !SYNC_PAGE_KINDS.has(String(kind))) return false;
  if (knockOnOf(row.error_detail)) return true;
  return kind != null && legacyKnockOnMessage(row.state, row.error_code, row.error_message);
}

/** The request a knock-on depended on, when its canceller recorded it. */
export function knockOnRoot(row: Pick<WriteRequest, 'error_detail'>): string | null {
  return knockOnOf(row.error_detail)?.root_request_id ?? null;
}

const sqlString = (value: string) => `'${value.replaceAll("'", "''")}'`;
/**
 * The same predicate as `isSyncKnockOn` over a `persistence_requests` alias, for the checkpoint's clause 3. Literal
 * strings only (no parameters), so every engine plans it the same way; never NULL, so `NOT` of it is safe.
 */
export function syncKnockOnSql(alias: string): string {
  const r = alias;
  return `COALESCE((${r}.state IN ('cancelled','failed','conflict') AND ${r}.recovery IS NULL AND NOT COALESCE(${r}.publication_started,false)
    AND (${r}.error_detail->>'origin' = ${sqlString(SYNC_KNOCK_ON_ORIGIN)}
      OR (${r}.state='cancelled' AND ${r}.error_code='cancelled' AND (${r}.error_message IN (${LEGACY_KNOCK_ON_CANCEL_MESSAGES.map(sqlString).join(',')})
        OR ${LEGACY_KNOCK_ON_CANCEL_PATTERNS.map(pattern => `${r}.error_message LIKE ${sqlString(pattern)}`).join(' OR ')}))
      OR (${r}.state IN ('conflict','failed') AND ${r}.error_code='revision_conflict' AND ${r}.error_message=${sqlString(EARLIER_PAGE_REFUSAL_MESSAGE)}))), false)`;
}
