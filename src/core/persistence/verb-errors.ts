import { verbError, opError, OperationError } from '../ops/contract.ts';
import type { Action } from '../agent-output.ts';
import { isTerminalWriteState, isWriteErrorCode, type WriteErrorCode, type WriteReceipt } from './types.ts';
import { pendingWriteHint } from './health.ts';
import { UNBOUND_COLLISION_MESSAGE, UNBOUND_PUBLICATION_MESSAGE } from './unbound-source.ts';
import { isFrontmatterHoldMessage } from '../markdown.ts';
import { fenceLocationFromMessage, fenceWhere } from '../fence-repair/refusal.ts';
import { FACT_WITHDRAWN_SUGGESTION } from '../facts/withdrawal.ts';
import { CHECKPOINT_MOVED_MESSAGE } from './sync-slug-mode.ts';

/** The refusal of a fact-batch completion request whose per-entity requests did not all commit (facts-prepare.ts). */
export const FACTS_BATCH_INCOMPLETE_MESSAGE = 'Some extracted facts have not committed.';

const FRONTMATTER_SLUG_CONFLICT = /^The frontmatter slug "[^"\n]{1,300}" in [^/"\n][^"\n]{0,1000} conflicts with its path, which expects slug "[^"\n]{1,300}"\. Remove `slug:` or make it match the path\.$/;

/** Sync refusal for a file whose frontmatter `slug:` names a different page than its path does. */
export function frontmatterSlugConflictMessage(path: string, found: string, expected: string): string {
  return `The frontmatter slug "${found}" in ${path} conflicts with its path, which expects slug "${expected}". Remove \`slug:\` or make it match the path.`;
}

/** #5988: the page's canonical file is held by sync; the code says why gbrain cannot import it. Location-free, so receipts may keep it. */
const HELD_FILE = /^(?:The canonical file is held by sync|A file held by sync) \(([a-z_]+)\) (and differs from the page|occupies the canonical page path); the page is read-only for put_page until the file is repaired\.$/;

/** #6693: the refusal of a page write whose file holds a committed Git change sync has not imported yet (pending-import.ts). */
/** #6858: the receipt prefix of a write `gbrain repair stuck-recovery --keep disk` abandoned: its canonical file was kept as edited on disk. */
export const KEEP_DISK_ABANDONED_PREFIX = 'Publication abandoned by gbrain repair stuck-recovery --keep disk';
export const PENDING_IMPORT_MESSAGE = 'The canonical file holds a committed Git change that sync has not imported yet.';

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
    : `frontmatter holds: preview the fix with gbrain repair frontmatter --source ${sourceId} and apply it; file_too_large: the file is over the page size limit, so exclude it with sync.exclude or split it into files under the limit`;
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
    if (message === PENDING_IMPORT_MESSAGE) return {
      reason: 'pending_import', message: 'A committed Git change to the page\'s file has not been imported yet; neither copy was overwritten.',
      suggestion: 'A refused remember is replayed once by the first managed sync that imports the file; do not save it again. Any other write: after the next gbrain sync --source <source> --no-pull, read the page again and resubmit with a new request_id.',
    };
    if (['Newer working-tree bytes and the current page disagree with this pinned Git import.',
      'Newer code file bytes disagree with the pinned import.', 'Canonical sanitization cannot overwrite newer working-tree bytes.'].includes(message ?? '')) return {
      reason: 'pinned_git_worktree_conflict', message: 'The pinned Git content conflicts with working-tree bytes; sync did not overwrite them.',
      suggestion: 'Inspect the exact working-tree bytes and pinned Git version, including CRLF/LF differences. Preserve local edits; do not normalize or discard them automatically. If the file and database disagree, preview gbrain sources reconcile <source> <slug> --brain <brain> --preview on the source host.',
    };
    if (['The imported file changed after sync admission.', 'The canonical file changed after preparation.',
      'The canonical file changed during preparation.'].includes(message ?? '') || (message ?? '').startsWith(KEEP_DISK_ABANDONED_PREFIX)) return {
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
  // #6501: a checkout recreated (or drifted beyond the birth tolerance) at its recorded path; the #5914 relocated-root self-transfer is the exit.
  if (code === 'recovery_required' && message?.startsWith('The checkout directory at the recorded root is not the one this owner stamped')) return { reason: 'physical_root_directory_changed', message,
    suggestion: 'On the brain host, gbrain sources writer status <source> --json shows the filled commands: gbrain sources writer transfer prepare <source> --self-transfer --confirm-relocated-root, then transfer accept <source> --path <root> --expected-epoch <epoch> --manifest <digest from prepare> --self-transfer --confirm-relocated-root (each with its admin intent). Retry the original write with the same request_id afterwards; never remove the ownership markers.' };
  if (code === 'owner_unavailable' && message === UNBOUND_PUBLICATION_MESSAGE) return { reason: 'unbound_source', message,
    suggestion: 'Read the page again and submit the write with a new request_id; a bound source publishes it to its canonical file.' };
  if (code === 'owner_unavailable') return { reason: code, message: 'The accepted source owner is unavailable or changed.',
    suggestion: 'Check the existing owner and its availability. Do not claim, transfer, or activate a source to repair content.' };
  if (code === 'permission_denied' || code === 'scope_denied') return { reason: code, message: 'The caller is not authorized for this write.',
    suggestion: 'Check the current caller grant for this source and operation. Content reconciliation does not grant permissions.' };
  // #6834: the checkpoint and fact-batch completion requests name bookkeeping slugs, not pages; there is nothing to read.
  if (code === 'revision_conflict' && message === CHECKPOINT_MOVED_MESSAGE) return { reason: 'sync_checkpoint_moved', message: 'The source\'s sync checkpoint moved while this run published; no page is in conflict.',
    suggestion: '__managed_sync_checkpoint__ is sync bookkeeping, not a page, so there is nothing to read or edit. gbrain sync status --source <source> --json names the next step: when the source already stands at this run\'s target the next sync finishes the run; otherwise preview gbrain repair managed-sync-orphans --source <source> and apply it with the hash it prints, and the next sync discovers from the commit the source records.' };
  if (code === 'revision_conflict' && message === FACTS_BATCH_INCOMPLETE_MESSAGE) return { reason: 'facts_batch_incomplete', message: 'Not every per-entity fact request of this extraction batch committed, so the batch was not recorded complete.',
    suggestion: '__managed_facts_complete__ is the batch\'s completion record, not a page, so there is nothing to read or edit. The facts that did commit stay; inspect the batch\'s entity requests with gbrain write-request <request_id>, and run the extraction again with a new request_id only if facts are still missing.' };
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
  // Wave B: a page whose body is stored in segments refuses a whole-body write; a deliberate per-page verdict, never a server fault.
  if (code === 'page_body_segmented') return { reason: code, message: message ?? SEGMENTED_WRITE_MESSAGE, suggestion: SEGMENTED_WRITE_SUGGESTION };
  // #5575: a purged claim or page content is refused for good; the owner alone can clear its tombstone.
  if (code === 'purged_content') return { reason: code, message: 'This content was purged from this source and cannot be saved again.',
    suggestion: PURGED_SUGGESTION };
  // Flip lane C: the receipt names the attempts, the limit and the SQLSTATE; the next step is the read-only writer status.
  if (code === 'write_interrupted' && message) return { reason: code, message,
    suggestion: 'Inspect the owner with gbrain sources writer status --source <source> --json (read-only), then submit the write again with a new request_id once the database is less loaded; a held sync file needs gbrain sources retry-held <source> and the same sync.' };
  const memory = code === 'invalid_params' ? MEMORY_REFUSAL.exec(message ?? '') : null;
  if (memory) return { reason: code, message: message!, suggestion: MEMORY_REFUSAL_SUGGESTION[/, extracted from that conversation page\.$/.test(message!) ? 'replaces_cross_page_derived' : memory[1]!]! };
  const reason = isWriteErrorCode(code) ? code : 'storage_error';
  return { reason, message: `The write did not commit: it ended with ${reason}, and nothing was saved.`,
    suggestion: 'Resolve the reported write failure before starting a corrected attempt.' };
}

const SEGMENTED_WRITE_MESSAGE = 'The target page stores its body in segments, and this write needs the whole body as one string; nothing was changed.';
const SEGMENTED_WRITE_SUGGESTION = 'The target page stores its body in segments over the 24 MiB limit up to which this write reads the body whole, so retrying refuses the same way. '
  + 'For remember: save the claim without an entity (omit entity, infer_entity: false); it is filed under memory/unattributed, and remembering it with entity once that page accepts fact rows replaces that copy. '
  + "Read the page with get_page body: 'auto' or a window.";

/** The next step of a `remember` refused because its entity page stores its body in segments: save the claim unattributed. */
export function segmentedRememberFix(): Action {
  return { argv: ['gbrain', 'remember', '<FACT>', '--provenance', '<PROVENANCE>', '--infer-entity', 'false'],
    mcp: { tool: 'remember', arguments: { fact: '<FACT>', provenance: '<PROVENANCE>', infer_entity: false } },
    inputs: [{ name: 'FACT', how: 'The claim you tried to remember, unchanged.' }, { name: 'PROVENANCE', how: 'The same provenance you passed.' }],
    consent: [], actor: 'agent', requires_exclusive: false,
    why: "Saves the claim without an entity: the entity page's facts fence cannot take a row while its body is stored in segments over 24 MiB. Remembering it with entity later replaces this copy." };
}

/** A `remember` whose entity (named or inferred) stores its body in segments: refused before admission with the unattributed-save fix. */
export function segmentedRememberRefusal(slug: string, sourceId: string, inferred: boolean): OperationError {
  return opError('page_body_segmented',
    `remember: the entity page ${slug} (source ${sourceId})${inferred ? ', inferred from a mention in the fact,' : ''} stores its body in segments over the 24 MiB limit up to which remember reads it whole, so remember cannot add a row to its facts fence. Nothing was saved.`,
    SEGMENTED_WRITE_SUGGESTION, { fix: segmentedRememberFix() });
}

const PURGED_SUGGESTION = 'Do not retry the same content. If it is still true, write it in new words; only the owner can clear a purge tombstone on the brain host.';

/** `remember` refusals decided at preparation (withdrawal, `replaces` under the target row lock) keep their code and next step. */
const MEMORY_REFUSAL = /^(fact_withdrawn|target_superseded|target_withdrawn|target_expired|replaces_entity_mismatch|replaces_cross_page|replaces_duplicate): /;
const MEMORY_REFUSAL_SUGGESTION: Record<string, string> = {
  fact_withdrawn: FACT_WITHDRAWN_SUGGESTION,
  target_superseded: 'Recall the entity to check the current fact, then pass replaces with the fact id named here if the new claim replaces that one.',
  target_withdrawn: 'Remember the new claim without replaces; the forgotten claim stays withdrawn.',
  target_expired: 'Remember the new claim without replaces.',
  replaces_entity_mismatch: 'Pass the same entity as the fact being replaced, or forget the old fact and remember the new one separately.',
  replaces_cross_page: 'Forget the old fact, then remember the new one.',
  replaces_cross_page_derived: 'Re-extract the conversation page named here to change its facts: preview with gbrain extract-conversation-facts --slugs <page> --force --dry-run, then run it with --max-cost-usd <n> (paid).',
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
      if (error.withdrawn) frozen.withdrawn = error.withdrawn;
      throw frozen;
    }
    // #5575: the frozen wire code stays invalid_params; the envelope's canonical code is purged_content.
    if ((error.canonical ?? error.code) === 'purged_content') {
      const purged = verbError('invalid_params', error.message, error.suggestion ?? PURGED_SUGGESTION);
      purged.canonical = 'purged_content'; purged.writeError = 'purged_content';
      throw purged;
    }
    // Wave B: a segmented target is a caller-class refusal; the frozen wire code is invalid_params and the canonical code says why.
    if (error.canonicalCode === 'page_body_segmented') {
      const segmented = verbError('invalid_params', error.message, error.suggestion ?? SEGMENTED_WRITE_SUGGESTION);
      Object.assign(segmented, { canonical: 'page_body_segmented', writeError: 'page_body_segmented', fix: error.fix ?? segmentedRememberFix() });
      throw segmented;
    }
    const code = ['permission_denied','scope_denied','source_changed','writer_registration_required'].includes(error.code)
      ? 'scope_denied' : ['revision_required','revision_conflict','idempotency_conflict','invalid_params','page_identity_changed'].includes(error.code)
        ? 'invalid_params' : 'unavailable';
    const diagnostic = error.code === 'source_changed' ? writeFailureDiagnostic(error.code, error.message) : null;
    const frozen = verbError(code,diagnostic?.message ?? error.message,diagnostic?.suggestion ?? error.suggestion ?? 'Inspect writer status before retrying.');
    if (diagnostic) frozen.detail = diagnostic.reason;
    if (error.code === 'idempotency_conflict' && error.fix) frozen.fix = error.fix;
    // #6608: an unbound-source refusal keeps its detail, docs and ask-the-user fix additively; the frozen code stays.
    if (error.detail === 'unbound_source') Object.assign(frozen, { detail: error.detail, docs: error.docs, fix: error.fix, retryable: error.retryable });
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
    : ['revision_required', 'revision_conflict', 'idempotency_conflict','invalid_params','page_identity_changed','purged_content','page_body_segmented'].includes(writeError) || writeError.startsWith('core_')
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
  if (writeError === 'purged_content') error.canonical = 'purged_content';
  if (writeError === 'page_body_segmented') Object.assign(error, { canonical: 'page_body_segmented', fix: segmentedRememberFix() });
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
