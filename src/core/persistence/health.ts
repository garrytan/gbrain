import { isTerminalWriteState, WRITE_HEALTH_REASONS, type WriteDiagnostic, type WriteReceipt, type WriteRequestState } from './types.ts';

export interface WriteHealthFacts {
  observed_at?: string;
  earlier_write?: boolean;
  recovery_required?: boolean;
  owner_unavailable?: boolean;
  inspect_owner?: boolean;
}
/** How long a pending write whose owner needs inspection waits before its caller polls again. */
export const INSPECT_OWNER_RETRY_MS = 30_000;
export function writeHealth(row: { state: WriteRequestState; created_at: Date | string; blocked_reason?: string | null },
  facts: WriteHealthFacts = {}, now = Date.now()): { retry_after_ms: number | null; diagnostic?: WriteDiagnostic } {
  if (isTerminalWriteState(row.state)) return { retry_after_ms: null };
  const created = new Date(row.created_at).getTime();
  const age = Number.isFinite(created) && Number.isFinite(now) ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(now - created))) : 0;
  const raw = row.blocked_reason;
  const unexpected = raw === 'unexpected_file_bytes' || raw === 'unexpected_staging_bytes';
  let reason: WriteDiagnostic['reason'] = unexpected || facts.inspect_owner || facts.recovery_required || row.state === 'recovering'
    ? 'recovery_required' : facts.owner_unavailable ? 'owner_unavailable' : facts.earlier_write ? 'waiting_on_earlier_write'
    : raw ? (WRITE_HEALTH_REASONS as readonly string[]).includes(raw) ? raw as WriteDiagnostic['reason'] : 'cause_unknown' : 'pending';
  const aged = age >= 120_000;
  const unknown = reason === 'pending' || reason === 'cause_unknown';
  if (aged && unknown) reason = 'cause_unknown';
  const inspect = aged || unexpected || facts.inspect_owner || ['writer_pool_capacity', 'owner_unavailable', 'writer_lock_unavailable'].includes(reason);
  return { retry_after_ms: inspect ? INSPECT_OWNER_RETRY_MS : !unknown || age >= 30_000 ? 5000 : 1000,
    diagnostic: { age_ms: age, assessment: unknown ? aged ? 'stalled' : 'pending' : 'blocked', reason,
      next_action: inspect ? 'inspect_owner' : 'poll', ...(facts.observed_at ? { observed_at: facts.observed_at } : {}) } };
}

export function pendingWriteHint(receipt: WriteReceipt, operation?: string): string {
  const identity = `Use the same operation with the same arguments and request_id ${receipt.request_id}. Do not submit a new request_id for this write.`;
  if (receipt.diagnostic?.next_action === 'inspect_owner') return `${identity} Ask the operator to inspect gbrain sources writer status --probe --json on the selected brain's existing owner. Do not claim, transfer, activate, or remove locks. Poll no faster than ${receipt.retry_after_ms ?? INSPECT_OWNER_RETRY_MS} ms; if receipt helpers are unavailable, replay the same verb only after inspection.`;
  return `${identity} Poll get_write_request after ${receipt.retry_after_ms ?? 1000} ms, or retry the same verb with identical arguments if receipt helpers are unavailable.${operation === 'put_page' ? ' Next time pass wait_ms (up to 30000) so the reply waits for the commit, and write more than 3 pages with put_pages.' : ''}`;
}
