/**
 * The `managedWrite` diagnostic of a managed sync result: what a page request's terminal receipt (or its pending state)
 * means for the operator, with the retry command and, for a pinned-worktree conflict, whether only line endings differ.
 * Moved out of `sync-run.ts` unchanged (#6340 kept that module under its size cap).
 */
import type { ManagedSyncWriteDiagnostic } from './sync-run.ts';
import type { SyncCursorOptions, SyncIntent } from './sync-prepare.ts';
import type { WriteRequest } from './model.ts';
import type { SyncProcessingOptions } from './sync-authority.ts';
import { isTerminalWriteState, publicWriteReceipt } from './types.ts';
import { receiptFor } from './journal.ts';
import { writeFailureDiagnostic } from './verb-errors.ts';
import { checkpointRetryCommand } from './checkpoint-validation.ts';
import { readSyncFile } from './sync-discovery.ts';
import { sha256 } from './digest.ts';

export function managedSyncWriteDiagnostic(cursor: { sourceId: string; root: string; processingOptions?: SyncProcessingOptions; syncOptions: SyncCursorOptions | null },
  pending: { slug: string; intent: SyncIntent }, row: WriteRequest): ManagedSyncWriteDiagnostic {
  const terminal = isTerminalWriteState(row.state);
  const code = terminal ? row.error_code ?? (row.state === 'cancelled' ? 'cancelled' : 'storage_error') : 'write_pending';
  const blockedReason = ['writer_busy', 'writer_pool_capacity', 'owner_unavailable', 'recovery_required', 'writer_lock_unavailable',
    'database_contention', 'consumer_stopping', 'revision_changed_repreparing', 'unexpected_file_bytes', 'unexpected_staging_bytes',
    'preparation_deadline', 'group_member_waiting'].includes(row.blocked_reason ?? '') ? row.blocked_reason! : 'write_pending';
  const detail = terminal ? writeFailureDiagnostic(code, row.error_message) : {
    reason: blockedReason, message: 'The write is accepted but not committed; the sync checkpoint has not advanced.',
    suggestion: 'Re-run the same sync options to resume this request. Do not submit a replacement request or skip the pending write.',
  };
  const diagnostic: ManagedSyncWriteDiagnostic = { source_id: cursor.sourceId, slug: pending.slug,
    path: pending.intent.path, write_error: code, ...detail, write_request: publicWriteReceipt(receiptFor(row)) };
  // #6194: an import that lost to a database write the hold could not prove; --retry-failed re-imports the Git version over it.
  if (terminal && code === 'revision_conflict' && pending.intent.kind === 'managed_sync_import') diagnostic.suggestion = `The page changed in the database after this import was frozen. `
    + `Before retrying, compare the file and the page with gbrain sources reconcile ${cursor.sourceId} ${pending.slug} --preview (it writes nothing): a retry re-imports the Git version over the database one. ${diagnostic.suggestion}`;
  if (terminal) diagnostic.suggestion += ` After repair, run ${checkpointRetryCommand({ sourceId: cursor.sourceId, processingOptions: cursor.processingOptions, syncOptions: cursor.syncOptions ?? null, repoPath: pending.intent.repoPath })} to start a new request. Without --retry-failed, the frozen terminal request returns the same outcome. Skipping failures cannot bypass a managed write.`;
  if (diagnostic.reason === 'pinned_git_worktree_conflict' && pending.intent.path && pending.intent.content !== null) {
    try {
      const bytes = readSyncFile(cursor.root, pending.intent.path);
      if (bytes && sha256(bytes) === pending.intent.rawHash && sha256(bytes) !== sha256(pending.intent.content)
        && bytes.equals(Buffer.from(bytes.toString('utf8')))
        && bytes.toString('utf8').replace(/\r\n/g, '\n') === pending.intent.content.replace(/\r\n/g, '\n')) {
        diagnostic.line_endings = 'crlf_lf_only';
        diagnostic.message += ' The frozen working-tree and Git versions differ only by CRLF/LF line endings; exact byte protection still applies.';
      }
    } catch {}
  }
  return diagnostic;
}
