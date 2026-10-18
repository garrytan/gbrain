import { setTimeout as delay } from 'node:timers/promises';
import { OperationError, opError } from '../ops/contract.ts';
import { getCode, isConnectionLoss } from '../retry-matcher.ts';

/** #6355: how many times an admission attempt is re-run after the session dropped under it, and the pauses before each re-run. */
export const CONNECTION_LOSS_RETRY_MS = [100, 300, 900] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * #6355: the typed outcome when the session kept dropping under the admission. Nothing here says whether the write was
 * accepted: the caller re-reads the retained request id (replaying the same request_id is a read, never a second admission).
 */
export function writeOutcomeUnknown(requestId: string, error: unknown): OperationError {
  const cause = error instanceof Error ? error.message.replace(/\b\w+:\/\/\S+/g, '<url>').slice(0, 160) : String(error).slice(0, 160);
  const uuid = UUID.test(requestId);
  const unknown = opError('write_outcome_unknown', 'The database connection dropped while this write was being admitted, so whether it was accepted is unknown.',
    uuid ? `Read request ${requestId} before doing anything else: a committed or pending row means the write was accepted (replay the same request_id to wait for it); no row means it was not (submit it again with the same request_id). Never submit it under a new request_id without that read.`
      : 'Read the writer status before doing anything else; replay the same request ids rather than allocating new ones.',
    { reason: 'connection_lost', detail: cause, fix: uuid
      ? { argv: ['gbrain', 'write-request', '--', requestId], mcp: { tool: 'get_write_request', arguments: { request_id: requestId } }, consent: [], actor: 'agent', requires_exclusive: false,
        why: `Reads request ${requestId}'s durable row, read-only: its presence and state are the truth the dropped connection could not deliver.` }
      : { argv: ['gbrain', 'sources', 'writer', 'status', '--json'], consent: [], actor: 'agent', requires_exclusive: false, why: 'Shows every pending, running or recovering request of this writer, read-only.' } });
  unknown.writeError = 'write_outcome_unknown';
  return unknown;
}

/**
 * Retry only database-confirmed transaction aborts, retaining the accepted intent and UUID. #6355: a session that drops
 * under the attempt (a pooler or failover closing the socket with the admission in flight) is re-run too, because every
 * attempt begins by reading the retained request id and replays an admitted row instead of admitting again; so re-running
 * is a read, never an inference of rollback. When the session keeps dropping, the caller gets `write_outcome_unknown`
 * with the id to read, never the raw socket error that a receipt oracle would take for a refusal.
 */
export async function retryWriteAdmission<T>(requestId: string, attempt: (remainingMs: number) => Promise<T>, budgetMs = 5000,
  recover?: (error: unknown) => Promise<void>): Promise<T> {
  const deadline = performance.now() + budgetMs;
  let lost = 0;
  for (;;) {
    try {
      return await attempt(Math.max(1, Math.floor(deadline - performance.now())));
    } catch (error) {
      const code = getCode(error);
      if (isConnectionLoss(error)) {
        const remaining = deadline - performance.now();
        if (lost >= CONNECTION_LOSS_RETRY_MS.length || remaining <= 25) throw writeOutcomeUnknown(requestId, error);
        await delay(Math.min(remaining - 1, CONNECTION_LOSS_RETRY_MS[lost++]!));
        // A pool whose sessions a pooler or failover killed hands out dead connections one statement at a time; the
        // engine's reconnect swaps in a fresh pool (best-effort: a failed rebuild is the next attempt's error).
        await recover?.(error).catch(() => undefined);
        continue;
      }
      if (!['40001', '40P01', '55P03', '57014'].includes(code ?? '')) throw error;
      const remaining = deadline - performance.now();
      if (remaining <= 25) {
        const unavailable = new OperationError('storage_error', 'Write admission is temporarily blocked by database contention.',
          `Retry the same operation, arguments, and request_id ${requestId}. No queued receipt has been confirmed.`);
        unavailable.writeError = 'storage_error';
        unavailable.detail = 'database_contention';
        throw unavailable;
      }
      // The transaction has rolled back and released its connection before any
      // backoff. Jitter keeps independent ingress processes from retrying in step.
      await delay(Math.min(remaining - 1, code === '55P03' ? 5 + Math.random() * 20 : 25 + Math.random() * 75));
    }
  }
}

/**
 * #6278: the outstanding-request cap's `detail`, and its readers. A
 * `queue_capacity` refused because other requests hold the writer's
 * outstanding cap clears by itself once they settle, so a caller that can
 * wait (the managed drain) treats it as a wait; a cumulative cap (permanent
 * request IDs, receipt bytes) names its config key instead and never is.
 */
export const outstandingCapacityDetail = (used: number, limit: number): string => `outstanding=${used} limit=${limit}`;
const OUTSTANDING_DETAIL = /^outstanding=(\d+) limit=(\d+)$/;
export function isWriteCapacityWait(error: unknown): error is OperationError {
  return error instanceof OperationError && error.code === 'queue_capacity' && OUTSTANDING_DETAIL.test(error.detail ?? '');
}
/** The counts a write-capacity wait carries: how many requests are outstanding against which cap, and whose cap it is. */
export function outstandingCapacityOf(error: OperationError): { outstanding: number | null; limit: number | null; scope: 'principal' | 'brain' | null } {
  const match = OUTSTANDING_DETAIL.exec(error.detail ?? '');
  const scope = /\bbrain outstanding\b/.test(error.message) ? 'brain' : /\bprincipal outstanding\b/.test(error.message) ? 'principal' : null;
  return { outstanding: match ? Number(match[1]) : null, limit: match ? Number(match[2]) : null, scope };
}
