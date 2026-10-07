/**
 * #5600/#5601: an accepted write that has not committed yet is progress, not
 * a failure. It keeps its request identity and publishes later; the caller
 * records it and moves on, and a rerun resumes the same request. Shared by
 * connector sync, managed import and managed atom publication.
 */
import { OperationError } from '../ops/contract.ts';
import { isTerminalWriteState, type WriteReceipt } from './types.ts';

export function acceptedPendingReceipt(error: unknown): WriteReceipt | null {
  if (!(error instanceof OperationError) || error.code !== 'write_pending' || !error.writeRequest) return null;
  return isTerminalWriteState(error.writeRequest.state) ? null : error.writeRequest;
}

/** Why a maintenance publication may finish on a later run instead of failing this one (#6052). */
export type PublicationHold = 'pending' | 'contention';

/**
 * #6052: two publication failures are progress, not phase failures. An
 * accepted, non-terminal receipt still publishes under its request id; an
 * admission that ran out of budget on database contention (admission-retry.ts)
 * confirmed no receipt and recorded nothing, so the next run re-admits the same
 * intent. Read from structured fields of a real OperationError only — never
 * from a message, a generic storage_error, a contention error that carries a
 * receipt, a terminal receipt or a permission refusal.
 */
export function publicationHold(error: unknown): PublicationHold | null {
  if (acceptedPendingReceipt(error)) return 'pending';
  if (error instanceof OperationError && error.code === 'storage_error' && error.detail === 'database_contention'
    && error.writeRequest == null) return 'contention';
  return null;
}

/** Run one publication: null once it commits, its hold when it can finish later; every other error is rethrown. */
export async function publishOrHold(publish: () => Promise<unknown>): Promise<PublicationHold | null> {
  try {
    await publish();
  } catch (error) {
    const hold = publicationHold(error);
    if (hold === null) throw error;
    return hold;
  }
  return null;
}
