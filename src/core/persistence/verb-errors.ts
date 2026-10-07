import { verbError, OperationError } from '../ops/contract.ts';
import { isTerminalWriteState, isWriteErrorCode, type WriteErrorCode, type WriteReceipt } from './types.ts';
import { pendingWriteHint } from './health.ts';
import { UNBOUND_COLLISION_MESSAGE, UNBOUND_PUBLICATION_MESSAGE } from './unbound-source.ts';
import { isFrontmatterHoldMessage } from '../markdown.ts';
import { fenceLocationFromMessage, fenceWhere } from '../fence-repair/refusal.ts';
import { FACT_WITHDRAWN_SUGGESTION } from '../facts/withdrawal.ts';

const FRONTMATTER_SLUG_CONFLICT = /^The frontmatter slug "[^"\n]{1,300}" in [^/"\n][^"\n]{0,1000} conflicts with its path, which expects slug "[^"\n]{1,300}"\. Remove `slug:` or make it match the path\.$/;

/** Sync refusal for a file whose frontmatter `slug:` names a different page than its path does. */
export function frontmatterSlugConflictMessage(path: string, found: string, expected: string): string {
  return `The frontmatter slug "${found}" in ${path} conflicts with its path, which expects slug "${expected}". Remove \`slug:\` or make it match the path.`;
}

/** #5988: the page's canonical file is held by sync; the code says why gbrain cannot import it. Location-free, so receipts may keep it. */
const HELD_FILE = /^(?:The canonical file is held by sync|A file held by sync) \(([a-z_]+)\) (and differs from the page|occupies the canonical page path); the page is read-only for put_page until the file is repaired\.$/;

export function heldFileMessage(kind: 'drift' | 'occupied', code: string): string {
  return kind === 'drift'
    ? `The canonical file is held by sync (${code}) and differs from the page; the page is read-only for put_page until the file is repaired.`
    : `A file held by sync (${code}) occupies the canonical page path; the page is read-only for put_page until the file is repaired.`;
}

/** The diagnostic of a held-file refusal message (null for any other message); `sourceId` fills the commands when the caller knows it. */
export function heldFileDiagnostic(message: string | null | undefined, sourceId = '<source>'): { reason: string; message: string; suggestion: string } | null {
  const held = message ? HELD_FILE.exec(message) : null;
  if (!held) return null;
  // #6188 (D6): a fence hold routes to the fence repair, never to frontmatter repair.
  const repair = held[1] === 'invalid_fence'
    ? `the maintenance run repairs most fence holds by itself; to repair it now, preview with gbrain repair fences --source ${sourceId} (read-only: it names the planned repair or the exact edit) and run the apply command it prints`
    : `frontmatter holds: preview the fix with gbrain repair frontmatter --source ${sourceId} and apply it; file_too_large: split the file`;
  return { reason: held[2] === 'and differs from the page' ? 'file_database_drift' : 'canonical_path_occupied', message: message!,
    suggestion: `Sync holds this page's file because gbrain cannot import it; gbrain sources status ${sourceId} names the file${held[1] === 'invalid_fence' ? ', fence and reason' : ', line and key'}. `
      + 'The page keeps its last good revision and refuses put_page until the file is repaired, so retrying this write refuses the same way. '
      + `On the source host, repair the file first (${repair}), `
      + 'then submit the intended write with a new request_id. Neither copy was overwritten.' };
}

export function writeFailureDiagnostic(code: string, message?: string | null): { reason: string; message: string; suggestion: string } {
  const held = code === 'source_changed' ? heldFileDiagnostic(message) : null;
  if (held) return held;
  // Always-loaded core refusals carry their numbers and the owner command in the message.
  if (code.startsWith('core_') && message) return { reason: code, message,
    suggestion: 'Change the content as the message says, or ask the user for the owner step it names (docs/guides/core-memory.md).' };
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
    if (message === UNBOUND_COLLISION_MESSAGE) return {
      reason: 'unbound_source', message: 'A canonical file now occupies the path of a page written while its source was unbound. Neither copy was overwritten.',
      suggestion: 'The database page stays served. Rename or remove the canonical file, commit, and sync again, or copy what you need from the file into the page first.',
    };
    return { reason: 'source_changed', message: 'A canonical source input or binding changed; the write was refused.',
      suggestion: 'Inspect the source on its existing owner. For file/database drift, preview gbrain sources reconcile <source> <slug> --brain <brain> --preview. Do not change ownership or permissions to bypass this guard.' };
  }
  if (code === 'owner_unavailable' && message === UNBOUND_PUBLICATION_MESSAGE) return { reason: 'unbound_source', message,
    suggestion: 'Read the page again and submit the write with a new request_id; a bound source publishes it to its canonical file.' };
  if (code === 'owner_unavailable') return { reason: code, message: 'The accepted source owner is unavailable or changed.',
    suggestion: 'Check the existing owner and its availability. Do not claim, transfer, or activate a source to repair content.' };
  if (code === 'permission_denied' || code === 'scope_denied') return { reason: code, message: 'The caller is not authorized for this write.',
    suggestion: 'Check the current caller grant for this source and operation. Content reconciliation does not grant permissions.' };
  if (code === 'revision_conflict' || code === 'page_identity_changed') return { reason: code, message: 'The accepted page identity or revision no longer matches.',
    suggestion: 'Read the current page and review the intended change before submitting a corrected write.' };
  if (code === 'invalid_params' && message && FRONTMATTER_SLUG_CONFLICT.test(message)) return { reason: code, message,
    suggestion: 'Correct the frontmatter in the file and commit the change.' };
  if (code === 'invalid_params' && isFrontmatterHoldMessage(message)) return { reason: code, message: message!,
    suggestion: 'Correct the named frontmatter line in the file (one line per key, the whole value quoted) and commit the change.' };
  // #6188: a typed fence refusal (wire invalid_params, or take_row_collision) keeps its location-only message and the fence edit.
  const fence = fenceLocationFromMessage(code, message);
  // A verb's own target page (D19): read the page and fix the stored fence, or rewrite it whole with put_page (which normalizes what it can).
  if (fence?.reason === 'target_fence_malformed') return { reason: 'invalid_fence', message: message!,
    suggestion: `The target page's stored ${fenceWhere(fence)} does not parse, so nothing was changed. Read the page with get_page, fix that fence `
      + '(or write the whole page with put_page, which normalizes what it can and names every row it cannot), then retry.' };
  if (fence) return { reason: 'invalid_fence', message: message!,
    suggestion: `Edit ${fenceWhere(fence)} in the file as the message says and commit the change, or preview its repair with gbrain repair fences --source <source>; never edit the frontmatter for it. `
      + 'A managed sync with sync.holds=hold holds such a file instead of blocking, and the maintenance run repairs the held fences it can; under sync.holds=fail and on company-brain sources it blocks until the file is fixed in the repository.' };
  // #6188 (UC3): a company-brain source names the fence correction it will not write; the repository commit is the fix.
  if (code === 'source_writeback_required' && message?.startsWith('Canonical preparation would normalize a facts or takes fence (')) return { reason: code, message,
    suggestion: 'A company-brain source never rewrites repository files: fix the named fence in the repository, commit it, and resume the sync.' };
  const memory = code === 'invalid_params' ? MEMORY_REFUSAL.exec(message ?? '') : null;
  if (memory) return { reason: code, message: message!, suggestion: MEMORY_REFUSAL_SUGGESTION[memory[1]!]! };
  const reason = isWriteErrorCode(code) ? code : 'storage_error';
  return { reason, message: `The write did not commit: it ended with ${reason}, and nothing was saved.`,
    suggestion: 'Resolve the reported write failure before starting a corrected attempt.' };
}

/** `remember` refusals decided at preparation (withdrawal, `replaces` under the target row lock) keep their code and next step. */
const MEMORY_REFUSAL = /^(fact_withdrawn|target_superseded|target_withdrawn|target_expired|replaces_entity_mismatch|replaces_cross_page|replaces_duplicate): /;
const MEMORY_REFUSAL_SUGGESTION: Record<string, string> = {
  fact_withdrawn: FACT_WITHDRAWN_SUGGESTION,
  target_superseded: 'Recall the entity to check the current fact, then pass replaces with the fact id named here if the new claim replaces that one.',
  target_withdrawn: 'Remember the new claim without replaces; the forgotten claim stays withdrawn.',
  target_expired: 'Remember the new claim without replaces.',
  replaces_entity_mismatch: 'Pass the same entity as the fact being replaced, or forget the old fact and remember the new one separately.',
  replaces_cross_page: 'Forget the old fact, then remember the new one.',
  replaces_duplicate: 'Forget the replaced fact if it is no longer true; the existing fact named here already says the new claim.',
};

/** Apply the frozen contract at the verb boundary for CLI and every transport. */
export async function runMemoryWrite<T>(run: () => Promise<T>): Promise<T> {
  try { return await run(); } catch (error) {
    if (!(error instanceof OperationError)) throw error;
    if (error.protocolVersion === 1 && ['invalid_params','provenance_required','not_found','scope_denied','unavailable','budget_unsatisfiable','internal'].includes(error.code)) throw error;
    if (error.writeRequest) {
      const frozen = frozenVerbWriteError(error.writeRequest, error.writeError, error.message);
      // #6188: the frozen v1 code stays; the fence refusal's reason, location and issues ride along additively.
      if (error.canonicalCode === 'invalid_fence') Object.assign(frozen, { reason: error.reason, fence: error.fence, fenceIssues: error.fenceIssues });
      throw frozen;
    }
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
    : ['revision_required', 'revision_conflict', 'idempotency_conflict','invalid_params','page_identity_changed'].includes(writeError) || writeError.startsWith('core_')
      ? 'invalid_params' : 'unavailable';
  const diagnostic = writeFailureDiagnostic(writeError, message);
  const suggestion = pending
    ? pendingWriteHint(receipt)
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
