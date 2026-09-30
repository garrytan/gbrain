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
