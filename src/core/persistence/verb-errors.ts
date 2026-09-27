import { verbError, OperationError } from '../ops/contract.ts';
import { isTerminalWriteState, isWriteErrorCode, type WriteErrorCode, type WriteReceipt } from './types.ts';

/** Apply the frozen contract at the verb boundary for CLI and every transport. */
export async function runMemoryWrite<T>(run: () => Promise<T>): Promise<T> {
  try { return await run(); } catch (error) {
    if (!(error instanceof OperationError)) throw error;
    if (error.writeRequest) throw frozenVerbWriteError(error.writeRequest, error.writeError);
    if (error.protocolVersion === 1 && ['invalid_params','provenance_required','not_found','scope_denied','unavailable','budget_unsatisfiable','internal'].includes(error.code)) throw error;
    const code = ['permission_denied','scope_denied','source_changed','writer_registration_required'].includes(error.code)
      ? 'scope_denied' : ['revision_required','revision_conflict','idempotency_conflict','invalid_params','page_identity_changed'].includes(error.code)
        ? 'invalid_params' : 'unavailable';
    const frozen = verbError(code,error.message,error.suggestion ?? 'Inspect writer status before retrying.');
    if (isWriteErrorCode(error.code)) frozen.writeError=error.code;
    throw frozen;
  }
}

/** Queue states are additive detail; frozen MEMORY_VERBS v1 error codes never widen. */
export function frozenVerbWriteError(receipt: WriteReceipt, reason?: WriteErrorCode): OperationError {
  const pending = !isTerminalWriteState(receipt.state);
  const writeError = reason ?? (pending ? 'write_pending'
    : receipt.state === 'conflict' ? 'revision_conflict'
      : receipt.state === 'cancelled' ? 'cancelled' : 'storage_error');
  const code = ['source_changed','permission_denied','scope_denied','writer_registration_required'].includes(writeError) ? 'scope_denied'
    : ['revision_required', 'revision_conflict', 'idempotency_conflict','invalid_params','page_identity_changed'].includes(writeError)
      ? 'invalid_params' : 'unavailable';
  const suggestion = pending
    ? `Retry the same verb with the same arguments and request_id ${receipt.request_id}${receipt.retry_after_ms === null ? ' after checking writer availability' : ` after ${receipt.retry_after_ms} ms`}. Do not submit a new request_id for this write.`
    : receipt.state === 'conflict'
      ? 'Read the current state and submit any corrected write with a new request_id. Reusing this request_id returns the same conflict.'
      : receipt.state === 'cancelled'
        ? 'This request was cancelled. Submit a new request_id only if you want to make a new write.'
        : 'Resolve the reported write failure before submitting a new request_id. Reusing this request_id returns the same outcome.';
  const error = verbError(code,
    pending ? 'The write is accepted and awaiting completion.' : `The write ended with state ${receipt.state}.`,
    suggestion);
  error.writeError = writeError;
  error.writeRequest = receipt;
  return error;
}

/** A pending receipt can never become an inserted/expired MEMORY_VERBS success. */
export function committedVerbOutcome(receipt: WriteReceipt): Record<string, unknown> {
  if (receipt.state !== 'committed') throw frozenVerbWriteError(receipt);
  if (!receipt.outcome) {
    throw verbError('internal', 'The committed write receipt has no result.',
      'Inspect the write request on the host. Do not submit a second write while its committed outcome is being recovered.');
  }
  return receipt.outcome;
}
