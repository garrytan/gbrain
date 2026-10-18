/**
 * sync_freshness's verdict for a source with no successful sync recorded
 * (#4960). Freshness and sync outcome are separate: a live first sync is
 * `warn` (running is not fresh), and a source with no lock is `fail` with its
 * last attempt (time, result, holds) and a fix for that state: wait, inspect
 * holds, or retry. Each entry carries its registered code for `details`.
 */
import type { Action } from '../../core/agent-output.ts';
import type { BrainEngine } from '../../core/engine.ts';
import { readLastSyncAttempt, type SyncAttemptState } from '../../core/sync-attempt.ts';
import { classifyManagedSyncOrphans } from '../../core/persistence/managed-sync-orphans.ts';
import { isOwnedContentSchemaMissing, staleOwnedContent } from '../../core/shared-skills/content-freshness.ts';
import { agentFix, doctorVerify } from './check-fix.ts';

export interface SyncOutcomeEntry {
  source_id: string;
  code: 'sync_first_run_in_progress' | 'sync_no_successful_sync' | 'content_receipt_stale';
  reason: 'first_sync_running' | 'receipt_root_moved' | SyncAttemptState;
  last_attempt_at: string | null;
  result: string | null;
  held: number;
  job_id: number | null;
  fix: Action;
}

const DOCS = 'docs/guides/troubleshooting.md#sync-freshness-no-successful-sync';
const VERIFY = doctorVerify('sync_freshness');

/** `next: wait`: re-read the verdict once the running work finishes. */
const waitFix = (why: string): Action =>
  ({ argv: [...VERIFY.argv], consent: [], actor: 'provider', requires_exclusive: false, why, verify: VERIFY, docs: DOCS });

export function firstSyncRunning(sourceId: string, display: string, snap: { holder_pid: number; holder_host: string }): { issue: string; entry: SyncOutcomeEntry } {
  return {
    issue: `Source ${display}: first sync running (pid ${snap.holder_pid} on ${snap.holder_host}), no successful sync yet; wait for it to finish`,
    entry: { source_id: sourceId, code: 'sync_first_run_in_progress', reason: 'first_sync_running', last_attempt_at: null, result: 'running', held: 0, job_id: null,
      fix: waitFix(`The first sync of ${sourceId} holds its live sync lock; it stamps last_sync_at only when it succeeds, so wait and re-run this check rather than starting a second sync.`) },
  };
}

export async function noSuccessfulSync(engine: BrainEngine, sourceId: string, display: string, managed: boolean): Promise<{ issue: string; entry: SyncOutcomeEntry }> {
  const stale = managed ? (await staleOwnedContent(engine, [sourceId]).catch(error => { if (isOwnedContentSchemaMissing(error)) return []; throw error; }))[0] : undefined;
  if (stale) return contentReceiptStale(sourceId, display);
  const attempt = await readLastSyncAttempt(engine, sourceId, managed);
  const retry: Action = { argv: ['gbrain', 'sync', '--source', sourceId, ...(managed ? ['--no-pull'] : [])], consent: [], actor: 'agent', requires_exclusive: false,
    verify: VERIFY, docs: DOCS, why: `No successful sync of ${sourceId} is recorded; this runs one and stamps last_sync_at when it succeeds.` };
  const inspect: Action = attempt.job_id !== null && !managed
    ? { argv: ['gbrain', 'jobs', 'get', String(attempt.job_id), '--json'], consent: [], actor: 'agent', requires_exclusive: false, verify: VERIFY, docs: DOCS,
      why: `Read-only: sync job #${attempt.job_id}'s status, result and error, before retrying.` }
    : { argv: ['gbrain', 'sync', 'status', '--source', sourceId, '--json'], consent: [], actor: 'agent', requires_exclusive: false, verify: VERIFY, docs: DOCS,
      why: `Read-only: the held files of ${sourceId}, each with its safe action, and the next step.` };
  const fix = attempt.state === 'attempt_queued'
    ? waitFix(`Sync job #${attempt.job_id} of ${sourceId} is queued or running; wait for it instead of starting another.`)
    : attempt.state === 'holds_pending' ? (attempt.managed_next ?? inspect)
      : attempt.state === 'last_attempt_unsuccessful' ? (attempt.managed_next ?? (attempt.job_id !== null ? { ...inspect, then: retry } : retry))
        : retry;
  const what = attempt.state === 'no_attempt'
    ? `no attempt recorded${attempt.unreadable ? ` (last attempt unreadable: ${attempt.unreadable})` : ''}`
    : `last attempt ${attempt.last_attempt_at ?? 'at an unknown time'}, result ${attempt.result ?? 'unknown'}, ${attempt.held} held`;
  const step = attempt.state === 'attempt_queued' ? 'wait for the queued sync' : attempt.state === 'holds_pending' ? `inspect holds with \`gbrain sync status --source ${sourceId}\``
    : `run \`${retry.argv!.join(' ')}\``;
  return {
    issue: `Source ${display}: no successful sync recorded; ${what}; ${step}`,
    entry: { source_id: sourceId, code: 'sync_no_successful_sync', reason: attempt.state, last_attempt_at: attempt.last_attempt_at, result: attempt.result,
      held: attempt.held, job_id: attempt.job_id, fix },
  };
}

/**
 * C-7 (#6892): a gbrain-owned content source never syncs, and doctor exempts it only while its content receipt names
 * the source's root. A receipt left on an old root (a transfer or relocation, or a set-path still to run) is
 * `content_receipt_stale`, fixed by the preview of `gbrain repair content-receipt-root`, never by a sync that refuses.
 */
function contentReceiptStale(sourceId: string, display: string): { issue: string; entry: SyncOutcomeEntry } {
  const fix = agentFix(['gbrain', 'repair', 'content-receipt-root', '--source', sourceId],
    `The content receipt of ${sourceId} names another root than the source and its owner binding (a writer transfer or relocation moved it). `
      + 'The preview checks the owner\'s tree against the recorded manifest and prints the apply command with its hash, or names what to fix first; writes nothing.',
    'sync_freshness', { docs: 'docs/guides/repair.md#content-receipt-root' });
  return {
    issue: `Source ${display}: no successful sync recorded; it is a gbrain-owned content directory whose content receipt names an old root, so sync does not apply and doctor cannot exempt it; run \`${fix.argv!.join(' ')}\``,
    entry: { source_id: sourceId, code: 'content_receipt_stale', reason: 'receipt_root_moved', last_attempt_at: null, result: null, held: 0, job_id: null, fix },
  };
}

/**
 * #6831: sync_freshness's verdict for each Google or GitHub connector source whose last CONNECTOR_STOPPED_RUNS or more
 * runs ended on an error. Such a source imports nothing, but its last_sync_at can still look recent, so freshness alone
 * reads it as healthy. The line names the error, the item and the read-only next step; it is a failure once the source's
 * last successful sync is older than `failBeforeMs` (sync_freshness's fail age), a warning before that.
 */
export async function stoppedConnectorIssues(engine: BrainEngine, sources: Array<{ id: string; last_sync_at: string | Date | null }>,
  failBeforeMs: number): Promise<Map<string, { issue: string; fail: boolean }>> {
  const { readConnectorLastError } = await import('../../core/persistence/connector-status.ts');
  const issues = new Map<string, { issue: string; fail: boolean }>();
  for (const source of sources) {
    const failure = await readConnectorLastError(engine, source.id);
    if (!failure?.stopped) continue;
    issues.set(source.id, { fail: !source.last_sync_at || new Date(source.last_sync_at).getTime() < failBeforeMs,
      issue: `Source '${source.id}' is STOPPED: its last ${failure.consecutive} connector syncs ended on ${failure.code}${failure.slug ? ` at ${failure.slug}` : ''} `
        + `(last ${failure.at.slice(0, 16).replace('T', ' ')}), so nothing from it is imported; inspect with \`${failure.fix.argv!.join(' ')}\`` });
  }
  return issues;
}

/**
 * #6834: the fix for stale managed sources whose unfinished cursor no sync can publish (its checkpoint lost to a
 * `last_commit` that moved outside the run): `gbrain repair managed-sync-orphans` retires it, so the remedy is the
 * preview, not another sync. Null when none of them has a `checkpoint_moved` cursor or the read fails.
 */
export async function checkpointMovedFix(engine: BrainEngine, staleIds: string[]): Promise<{ fix: Action; note: string } | null> {
  const moved = (await classifyManagedSyncOrphans(engine, staleIds).catch(() => ({ orphans: [] }))).orphans.filter(orphan => orphan.reason === 'checkpoint_moved');
  if (!moved.length) return null;
  const ids = [...new Set(moved.map(orphan => orphan.source_id))];
  const fix = agentFix(['gbrain', 'repair', 'managed-sync-orphans', ...(ids.length === 1 ? ['--source', ids[0]!] : [])],
    `The unfinished sync of ${ids.join(', ')} can never checkpoint (its source's last_commit moved outside the run), so a plain sync stays blocked. The preview lists the cursor and prints the apply command with its hash; writes nothing.`,
    'sync_freshness', { docs: 'docs/guides/repair.md#managed-sync-orphans' });
  return { fix, note: `. ${fix.why} Run \`${fix.argv!.join(' ')}\`` };
}
