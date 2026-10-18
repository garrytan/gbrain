/**
 * The `managedWrite` diagnostic of a managed sync result: what a page request's terminal receipt (or its pending state)
 * means for the operator, with the retry command and, for a pinned-worktree conflict, whether only line endings differ.
 * Moved out of `sync-run.ts` unchanged (#6340 kept that module under its size cap; `writeWaitOf` followed for #6513).
 */
import type { ManagedSyncWriteDiagnostic } from './sync-run.ts';
import type { WriteWait } from './service.ts';
import type { SyncCursorOptions, SyncIntent } from './sync-prepare.ts';
import type { WriteRequest } from './model.ts';
import type { SyncProcessingOptions } from './sync-authority.ts';
import { isTerminalWriteState, publicWriteReceipt } from './types.ts';
import { receiptFor } from './journal.ts';
import { writeFailureDiagnostic } from './verb-errors.ts';
import { checkpointRetryCommand } from './checkpoint-validation.ts';
import { readSyncFile } from './sync-discovery.ts';
import { sha256 } from './digest.ts';
import { classifyTerminal } from './terminal-classify.ts';

export function managedSyncWriteDiagnostic(cursor: { sourceId: string; root: string; processingOptions?: SyncProcessingOptions; syncOptions: SyncCursorOptions | null },
  pending: { slug: string; intent: SyncIntent }, row: WriteRequest): ManagedSyncWriteDiagnostic {
  const terminal = isTerminalWriteState(row.state);
  const code = terminal ? row.error_code ?? (row.state === 'cancelled' ? 'cancelled' : 'storage_error') : 'write_pending';
  const blockedReason = ['writer_busy', 'writer_pool_capacity', 'owner_unavailable', 'recovery_required', 'writer_lock_unavailable',
    'database_contention', 'consumer_stopping', 'revision_changed_repreparing', 'unexpected_file_bytes', 'unexpected_staging_bytes',
    'preparation_deadline', 'group_member_waiting', 'lane_lock_timeout', 'lane_statement_timeout'].includes(row.blocked_reason ?? '') ? row.blocked_reason! : 'write_pending';
  const detail = terminal ? writeFailureDiagnostic(code, row.error_message) : {
    reason: blockedReason, message: 'The write is accepted but not committed; the sync checkpoint has not advanced.',
    suggestion: 'Re-run the same sync options to resume this request. Do not submit a replacement request or skip the pending write.',
  };
  // #6712 PR 2 (L5): a terminal receipt's diagnosis category, and the public one beside it, from the one classifier.
  const verdict = terminal ? classifyTerminal({ request_id: row.request_id, source_id: row.source_id, slug: row.slug, operation: row.operation, state: row.state, error_code: row.error_code,
    error_detail: row.error_detail ?? null, recovery: row.recovery, blocked_reason: row.blocked_reason, compacted: row.compacted, publication_started: row.publication_started,
    error_message: row.error_message, intent_kind: typeof row.intent?.kind === 'string' ? row.intent.kind : null }) : null;
  const diagnostic: ManagedSyncWriteDiagnostic = { source_id: cursor.sourceId, slug: pending.slug,
    path: pending.intent.path, write_error: code, ...detail, ...(verdict ? { category: verdict.category, public_category: verdict.public_category } : {}),
    write_request: publicWriteReceipt(receiptFor(row)) };
  // #6194: an import that lost to a database write the hold could not prove; the retry re-imports the Git version unless discovery's drift guard holds it.
  if (terminal && code === 'revision_conflict' && pending.intent.kind === 'managed_sync_import') diagnostic.suggestion = `The page changed in the database after this import was frozen. `
    + `Before retrying, compare the file and the page with gbrain sources reconcile ${cursor.sourceId} ${pending.slug} --preview (it writes nothing): a retry re-imports the Git version over the database one. ${diagnostic.suggestion}`;
  if (terminal) diagnostic.suggestion += ` After repair, run ${checkpointRetryCommand({ sourceId: cursor.sourceId, processingOptions: cursor.processingOptions, syncOptions: cursor.syncOptions ?? null, repoPath: pending.intent.repoPath })} to retry it under a new request. Skipping failures cannot bypass a managed write.`;
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

/** DX-A3 / ENG-A12: how the wait for a still-unfinished sync write ended, with its request ID kept. */
export type ManagedSyncWriteWait = { status: 'pending'; request_id: string }
  | { status: 'blocked'; request_id: string; cause: string; command: string }
  | { status: 'read_failed'; request_id: string; reason: string; transient: boolean; sqlstate?: string; attempts: number; message: string; why: string };
export function writeWaitOf(wait: WriteWait): ManagedSyncWriteWait {
  if (wait.kind === 'blocked') return { status: 'blocked', request_id: wait.request_id, cause: wait.cause, command: wait.command };
  if (wait.kind !== 'read_failed') return { status: 'pending', request_id: wait.row.request_id };
  const { kind: _kind, row: _row, ...failure } = wait;
  return { status: 'read_failed', ...failure };
}
