import { verbError, OperationError } from '../ops/contract.ts';
import { isTerminalWriteState, isWriteErrorCode, type WriteErrorCode, type WriteReceipt } from './types.ts';

export function writeFailureDiagnostic(code: string, message?: string | null): { reason: string; message: string; suggestion: string } {
  if (code === 'source_changed') {
    if (message === 'The canonical file contains an uncoordinated local edit.') return {
      reason: 'file_database_drift', message: 'The canonical file and database disagree. Neither copy was overwritten.',
      suggestion: 'On the source host, run gbrain sources reconcile <source> <slug> --brain <brain> --preview. Review and apply the resolved preview before retrying the original write with a new request_id. This is data repair, not an ownership or permission change.',
    };
    if (['Newer working-tree bytes and the current page disagree with this pinned Git import.',
      'Newer code file bytes disagree with the pinned import.', 'Canonical sanitization cannot overwrite newer working-tree bytes.'].includes(message ?? '')) return {
      reason: 'pinned_git_worktree_conflict', message: 'The pinned Git content conflicts with working-tree bytes; sync did not overwrite them.',
      suggestion: 'Inspect the exact working-tree bytes and pinned Git version, including CRLF/LF differences. Preserve local edits; do not normalize or discard them automatically. If the file and database disagree, preview gbrain sources reconcile <source> <slug> --brain <brain> --preview on the source host.',
    };
    if (['The imported file changed after sync admission.', 'The canonical file changed after preparation.',
      'The canonical file changed during preparation.'].includes(message ?? '')) return {
      reason: 'raw_file_changed', message: 'The source file bytes changed after this request was accepted.',
      suggestion: 'Review the changed file before starting a corrected attempt. Exact byte checks remain required even when Git reports a clean file.',
    };
    if (message === 'The canonical file was removed outside coordinated publication.') return {
      reason: 'canonical_file_missing', message: 'The canonical file is missing; the database page was not overwritten.',
      suggestion: 'Review the deletion and recover the intended canonical file or import the intended deletion before retrying. Reconciliation does not restore missing files.',
    };
    if (message === 'An unindexed file already occupies the canonical page path.') return {
      reason: 'canonical_path_occupied', message: 'An unindexed file already occupies this page path; it was not overwritten.',
      suggestion: 'Review and import the existing file before retrying the intended page write.',
    };
    if (['The canonical file target is outside its registered source.', 'The registered source root was replaced by a symlink.',
      'Sync file escaped its registered root.', 'Sync cannot publish through a symlink.', 'Sync target is not a regular file.'].includes(message ?? '')) return {
      reason: 'unsafe_file_target', message: 'The file target no longer meets the registered source confinement checks.',
      suggestion: 'Inspect the registered source and file type on its owner. Do not bypass confinement checks or replace ownership to force publication.',
    };
    if (message === 'The unfinished sync cursor belongs to an older source binding.' || message === 'The original sync source was replaced.') return {
      reason: 'source_binding_changed', message: 'The source binding changed after this sync was accepted.',
      suggestion: 'Inspect the current source binding on its existing owner. Do not claim, transfer, or activate a source as a data-repair shortcut.',
    };
    return { reason: 'source_changed', message: 'A canonical source input or binding changed; the write was refused.',
      suggestion: 'Inspect the source on its existing owner. For file/database drift, preview gbrain sources reconcile <source> <slug> --brain <brain> --preview. Do not change ownership or permissions to bypass this guard.' };
  }
  if (code === 'owner_unavailable') return { reason: code, message: 'The accepted source owner is unavailable or changed.',
    suggestion: 'Check the existing owner and its availability. Do not claim, transfer, or activate a source to repair content.' };
  if (code === 'permission_denied' || code === 'scope_denied') return { reason: code, message: 'The caller is not authorized for this write.',
    suggestion: 'Check the current caller grant for this source and operation. Content reconciliation does not grant permissions.' };
  if (code === 'revision_conflict' || code === 'page_identity_changed') return { reason: code, message: 'The accepted page identity or revision no longer matches.',
    suggestion: 'Read the current page and review the intended change before submitting a corrected write.' };
  return { reason: isWriteErrorCode(code) ? code : 'storage_error', message: 'The write did not commit. Inspect its durable request on the source host.',
    suggestion: 'Resolve the reported write failure before starting a corrected attempt.' };
}

/** Apply the frozen contract at the verb boundary for CLI and every transport. */
export async function runMemoryWrite<T>(run: () => Promise<T>): Promise<T> {
  try { return await run(); } catch (error) {
    if (!(error instanceof OperationError)) throw error;
    if (error.protocolVersion === 1 && ['invalid_params','provenance_required','not_found','scope_denied','unavailable','budget_unsatisfiable','internal'].includes(error.code)) throw error;
    if (error.writeRequest) throw frozenVerbWriteError(error.writeRequest, error.writeError, error.message);
    const code = ['permission_denied','scope_denied','source_changed','writer_registration_required'].includes(error.code)
      ? 'scope_denied' : ['revision_required','revision_conflict','idempotency_conflict','invalid_params','page_identity_changed'].includes(error.code)
        ? 'invalid_params' : 'unavailable';
    const diagnostic = error.code === 'source_changed' ? writeFailureDiagnostic(error.code, error.message) : null;
    const frozen = verbError(code,diagnostic?.message ?? error.message,diagnostic?.suggestion ?? error.suggestion ?? 'Inspect writer status before retrying.');
    if (diagnostic) frozen.detail = diagnostic.reason;
    if (isWriteErrorCode(error.code)) frozen.writeError=error.code;
    throw frozen;
  }
}

/** Queue states are additive detail; frozen MEMORY_VERBS v1 error codes never widen. */
export function frozenVerbWriteError(receipt: WriteReceipt, reason?: WriteErrorCode, message?: string): OperationError {
  const pending = !isTerminalWriteState(receipt.state);
  const writeError = reason ?? (pending ? 'write_pending'
    : receipt.state === 'conflict' ? 'revision_conflict'
      : receipt.state === 'cancelled' ? 'cancelled' : 'storage_error');
  const code = ['source_changed','permission_denied','scope_denied','writer_registration_required'].includes(writeError) ? 'scope_denied'
    : ['revision_required', 'revision_conflict', 'idempotency_conflict','invalid_params','page_identity_changed'].includes(writeError)
      ? 'invalid_params' : 'unavailable';
  const diagnostic = writeFailureDiagnostic(writeError, message);
  const suggestion = pending
    ? `Retry the same verb with the same arguments and request_id ${receipt.request_id}${receipt.retry_after_ms === null ? ' after checking writer availability' : ` after ${receipt.retry_after_ms} ms`}. Do not submit a new request_id for this write.`
    : receipt.state === 'cancelled'
        ? 'This request was cancelled. Submit a new request_id only if you want to make a new write.'
        : `${diagnostic.suggestion} Submit any corrected write with a new request_id. Reusing this request_id returns the same ${receipt.state === 'conflict' ? 'conflict' : 'outcome'}.`;
  const error = verbError(code,
    pending ? 'The write is accepted and awaiting completion; it is not committed.' : diagnostic.message,
    suggestion);
  if (!pending) error.detail = diagnostic.reason;
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
