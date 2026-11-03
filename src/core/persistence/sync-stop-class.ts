/**
 * #6712 (L2 one page, one fate; #6565): how a managed sync run classifies a page request that ended without committing,
 * and whether an earlier invocation already stopped the run, so the settle path in sync-run.ts can route it: hold or
 * defer a page fault, re-freeze a transport fault in place, stop on a systemic one and re-freeze it on the next plain
 * sync when the fault table retries it.
 */
import type { BrainEngine } from '../engine.ts';
import type { WriteRequest } from './model.ts';
import { classifyTerminal } from './terminal-classify.ts';
import { classifySyncFault } from './sync-fault-class.ts';
import { isContentRefusal } from '../import-screen.ts';
import { sha256 } from './digest.ts';
import { readSyncFile } from './sync-discovery.ts';
import { VERSION } from '../../version.ts';
import { pinnedWorktreeConflict } from './sync-page-fault.ts';
import { LockStolenError } from '../db-lock.ts';
import { OperationError } from '../ops/contract.ts';
import { isWriteCapacityWait } from './admission-retry.ts';
import { isRetryableConnError, isStatementTimeoutError } from '../retry-matcher.ts';

/**
 * A stop a managed sync run records no failure for, so the next pass resumes it: `lease_lost` when the pass lost its drain
 * lease (a lapse or a takeover); `transient` for a refresh fence, write back-pressure (#6278), a lost database connection or
 * a statement timeout (#6340), or a permission refusal. #7614: the pass ends its row `resumable` with this stop reason, so
 * only a process that died leaves an open row (status and doctor read an open row with no live holder as killed). A pass
 * that lost its lease writes that row unfenced, guarded by the row's lease token alone: a pass that pinned since keeps its row.
 * A permission refusal is the exception (`resumableRowStop`): it repeats on every pass until an operator acts, so its row
 * stays open and reads `pass_interrupted`, then `pass_abandoned`, instead of a resumable pass a plain sync would retry forever.
 */
export function unrecordedStop(error: unknown): 'lease_lost' | 'transient' | null {
  if (error instanceof LockStolenError) return 'lease_lost';
  const code = error instanceof OperationError ? error.code : null;
  return (code !== null && ['permission_denied', 'worktree_refreshing', 'refresh_recovery_required'].includes(code)) || isWriteCapacityWait(error)
    || isRetryableConnError(error) || isStatementTimeoutError(error) ? 'transient' : null;
}

/** The stop reason a pass row ends `resumable` with: `unrecordedStop` less a permission refusal. */
export function resumableRowStop(error: unknown): 'lease_lost' | 'transient' | null {
  return error instanceof OperationError && error.code === 'permission_denied' ? null : unrecordedStop(error);
}

/**
 * #6712 (#6565): how the run treats a receipt that did not commit, from the terminal classifier: `transport` (a dropped
 * connection, a retryable or unavailable refusal) re-freezes in place now; `page` is a fault of the one entry (held when
 * positively classified, else it blocks under the hold policy); `systemic` (the engine-graduation fence, an unknown
 * P0001, schema skew, any refusal it cannot place) stops the run blocked with the classifier's action.
 */
export function receiptClass(row: WriteRequest): 'transport' | 'page' | 'systemic' {
  if (row.recovery) return 'systemic';
  const kind = (row.intent as Record<string, unknown> | null)?.kind;
  const verdict = classifyTerminal({ request_id: row.request_id, source_id: row.source_id, slug: row.slug, operation: row.operation, state: row.state, error_code: row.error_code ?? null,
    error_detail: (row.error_detail ?? null) as object | null, recovery: row.recovery, blocked_reason: row.blocked_reason, compacted: row.compacted, publication_started: row.publication_started,
    intent_kind: typeof kind === 'string' ? kind : null, error_message: row.error_message ?? null });
  if (verdict?.category === 'transport' && verdict.code !== 'graduation_in_progress') return 'transport';
  return verdict?.class === 'page' ? 'page' : 'systemic';
}
/**
 * #6712 (#6565): a stop the next plain sync re-freezes in place: a database refusal the fault table retries (an
 * unrecognised P0001 or a 55000 raised under a page write surfaces as `storage_error`). A content, consent or option
 * refusal is never one: its receipt stays the diagnosis until the next sync takes the path again (a pass re-classifies it at HEAD).
 */
export function resumableStop(row: WriteRequest): boolean {
  const verdict = classifySyncFault({ code: row.error_code ?? 'storage_error', message: row.error_message ?? null });
  return verdict.class !== 'page' && verdict.safe_actions.includes('retry');
}
/**
 * #6712: whether an earlier invocation already stopped this run (its failure is recorded under the cursor key with the
 * run's id). An invocation records at most one stop and returns, so a recorded stop of the run is always an earlier one's,
 * and the pages its window admitted after the stop and the same refusal failed are re-frozen like the stop itself.
 */
export async function stopRecorded(engine: BrainEngine, key: string, runId: string): Promise<boolean> {
  return (await recordedStop(engine, key, runId)) !== null;
}
/** #6712 PR 3 (L7): this run's recorded stop with the gbrain version that recorded it (null on a row from before versions were kept), or null when none is. */
export async function recordedStop(engine: BrainEngine, key: string, runId: string): Promise<RecordedStop | null> {
  const [row] = await engine.executeRaw<RecordedStop>(
    "SELECT completed_keys->0->>'gbrain_version' AS gbrain_version FROM op_checkpoints WHERE op='managed-sync-failure' AND fingerprint=$1 AND completed_keys->0->>'run_id'=$2", [key, runId]);
  return row ?? null;
}
export interface RecordedStop { gbrain_version: string | null }

/**
 * #6712 PR 3 (L7): a content refusal is a function of the file's bytes and the parser that read them, so while both are the
 * ones that refused it (the file is unchanged and this gbrain version recorded the failure) the sync replays the recorded
 * failure without a new request. A changed file, an upgrade, or a failure an older build recorded is retried.
 */
export function replaysContentRefusal(failed: WriteRequest, recorded: { gbrain_version: string | null }, unchanged: () => boolean): boolean {
  return isContentRefusal(failed.error_code, failed.error_message) && recorded.gbrain_version === VERSION && unchanged();
}

/**
 * #6712 PR 3 (L7): whether the next sync replays a page's recorded refusal instead of retrying it, because what decides it
 * has not changed since this gbrain version recorded it: a content refusal while the file has its frozen bytes, and a pinned
 * import refused for newer working-tree bytes (`source_changed`) while HEAD is still the run's target and the file still
 * holds the working-tree bytes that refused (the frozen `rawHash`). Bytes decide, never the
 * file's mtime against the stop's database timestamp: those are two clocks, and a correction written within their skew
 * (a filesystem timestamp lags the wall clock by up to a scheduler tick) read as unwritten and replayed the refusal.
 * Committing the file, editing it or upgrading gbrain retries it. #6712 PR 4b: the pass replays what its last blocked pass
 * stopped on (sync-pass-run.ts, under sync.holds=fail).
 */
export function replaysUnchangedRefusal(failed: WriteRequest, recorded: RecordedStop,
  entry: { root: string; intent: { path?: string | null; rawHash?: string | null }; target: string; head: () => string }): boolean {
  if (replaysContentRefusal(failed, recorded, () => fileUnchangedSinceFreeze(entry.root, entry.intent))) return true;
  if (!pinnedWorktreeConflict(failed) || recorded.gbrain_version !== VERSION || !entry.intent.path || entry.head() !== entry.target) return false;
  return fileUnchangedSinceFreeze(entry.root, entry.intent);
}

/** Whether the entry's file still has the bytes its frozen request carried (a missing file, for a deletion). */
export function fileUnchangedSinceFreeze(root: string, intent: { path?: string | null; rawHash?: string | null }): boolean {
  if (!intent.path) return true;
  try {
    const bytes = readSyncFile(root, intent.path);
    return (bytes === null ? null : sha256(bytes)) === (intent.rawHash ?? null);
  } catch { return false; }
}
