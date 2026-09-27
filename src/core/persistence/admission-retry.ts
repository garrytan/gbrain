import { setTimeout as delay } from 'node:timers/promises';
import { OperationError } from '../ops/contract.ts';
import { getCode } from '../retry-matcher.ts';

/** Retry only database-confirmed transaction aborts, retaining the accepted intent and UUID. */
export async function retryWriteAdmission<T>(requestId: string, attempt: (remainingMs: number) => Promise<T>): Promise<T> {
  const deadline = performance.now() + 5000;
  for (;;) {
    try {
      return await attempt(Math.max(1, Math.floor(deadline - performance.now())));
    } catch (error) {
      // Connection/commit uncertainty is deliberately excluded: the caller must
      // inspect/replay its retained ID, never infer rollback from a lost socket.
      if (!['40001', '40P01', '55P03', '57014'].includes(getCode(error) ?? '')) throw error;
      const remaining = deadline - performance.now();
      if (remaining <= 25) {
        const unavailable = new OperationError('storage_error', 'Write admission is temporarily blocked by database contention.',
          `Retry the same operation, arguments, and request_id ${requestId}. No queued receipt has been confirmed.`);
        unavailable.writeError = 'storage_error';
        throw unavailable;
      }
      // The transaction has rolled back and released its connection before any
      // backoff. Jitter keeps independent ingress processes from retrying in step.
      await delay(Math.min(remaining - 1, 25 + Math.random() * 75));
    }
  }
}
