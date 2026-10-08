import { setTimeout as delay } from 'node:timers/promises';
import { OperationError } from '../ops/contract.ts';
import { getCode } from '../retry-matcher.ts';

/** Retry only database-confirmed transaction aborts, retaining the accepted intent and UUID. */
export async function retryWriteAdmission<T>(requestId: string, attempt: (remainingMs: number) => Promise<T>, budgetMs = 5000): Promise<T> {
  const deadline = performance.now() + budgetMs;
  for (;;) {
    try {
      return await attempt(Math.max(1, Math.floor(deadline - performance.now())));
    } catch (error) {
      // Connection/commit uncertainty is deliberately excluded: the caller must
      // inspect/replay its retained ID, never infer rollback from a lost socket.
      const code = getCode(error);
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
