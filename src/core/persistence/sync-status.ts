/**
 * #6340: the machine-readable unblock contract for a managed catch-up, so an
 * operator agent can run the recovery loop without a person:
 *
 *   status every N minutes → if committed_last_10m == 0 and nothing needs a
 *   human → unblock --apply → rerun the sync it names → else page a person with
 *   the slug.
 *
 * `readSyncStatus` joins the unfinished cursor (position, pinned target, last
 * advance, rate), the pages committed in the last ten minutes, every hold and
 * the last recorded failure, each with the `class` / `safe_actions` /
 * `needs_human` triple from `sync-fault-class.ts`, and one `next` action.
 * `unblockSync` performs the safe action for every hold that has one (a
 * `worktree_dirty` hold whose file is now committed and a `preparation_stalled`
 * hold are scheduled for a re-screen; since #6377 a repair-class hold whose
 * code the content-repair lane clears, `CONTENT_REPAIR_HOLD_KINDS`, takes a
 * bounded hash-bound apply of that kind under the fence-repair caps, then the
 * re-screen) and refuses the rest by name: refusing is the only way it leaves a
 * page out, and it never drops content. A hold whose stored repair state says
 * a person decides (a manual fence reason, a paid wait, a recommended merge) is
 * listed, never retried. `--no-repair` restores the refuse-only behaviour,
 * `--no-llm` keeps the repairs to their free tiers. Both are trusted-local
 * readers (the CLI); paths are source-root relative, and the per-path repair
 * outcomes carry codes, tiers and hashes only.
 */
import type { BrainEngine } from '../engine.ts';
import type { Action } from '../agent-output.ts';
import { managedSyncResumeArgs } from '../sync-reconcile.ts';
import { readManagedSyncFailures, type ManagedSyncFailure } from './sync-failures.ts';
import { outOfAttemptsHold, fenceAutoRepairFor, gitHoldFix, holdEscalation, noteHoldEdit, readGitSourceHolds, recordHoldAttempt, requestGitHoldRetry, type GitHoldRecord } from './sync-holds.ts';
import type { FenceAutoRepair } from '../fence-repair/hold-fix.ts';
import { classifySyncFault, HOLD_ATTEMPTS_NEEDS_HUMAN, type SyncFaultVerdict } from './sync-fault-class.ts';
import { CONTENT_REPAIR_KINDS, contentHoldDisposition, runContentLane, type ContentHoldDisposition } from '../repair/content-lane.ts';
import { resolveRepairScope, type RepairKind, type RepairResult } from '../repair/core.ts';
import type { RepairKindSpec } from '../repair/registry.ts';
import { headCommittedBytes } from './sync-page-fault.ts';
import { laneFaultInMessage } from './sync-window.ts';
import { cursorFenceCause, syncKnockOnSql } from './sync-knock-on.ts';
import { listIncompleteSyncReceipts, type SyncSettledIndexes } from './checkpoint-validation.ts';
import { drainEstimate, engineStallProbe } from './sync-drain.ts';
import { classifyRecordedFault, classifyTerminal, type TerminalCategory } from './terminal-classify.ts';
import type { PublicCategory } from './public-category.ts';
import { readSyncFile, resolveManagedSyncContext } from './sync-discovery.ts';
import { sha256 } from './digest.ts';
import { listIdentityDowngrades, withIdentityRemedies } from '../sync-identity-downgrades.ts';
import { GIT_PUSH_CODES, readGitPushHolds, type GitPushHold } from './git-push-holds.ts';

export interface SyncStatusHold extends SyncFaultVerdict {
  code: string;
  /** #6712 PR 2: the `classifyTerminal` category of the hold's code and the public category beside it. */
  category: TerminalCategory;
  public_category: PublicCategory;
  slug: string | null;
  path: string;
  attempts: number;
  held_since: string;
  /** When the hold can be retried on its own: now (`null`), or never without the named step. */
  retry_after: string | null;
  fix: Action;
}

export interface SyncStatusError extends SyncFaultVerdict {
  code: string;
  /** #6712 PR 2: the `classifyTerminal` category of the recorded failure and the public category beside it. */
  category: TerminalCategory;
  public_category: PublicCategory;
  /** A refinement of `code`: a lane fault (`cancelled`), or #6513 the closed `reason` of a database refusal. */
  detail?: string;
  message: string;
  /** #6513: the receipt's public failure detail (origin, sqlstate, raiser, table, the closed reason; never message text). */
  write_error_detail?: Record<string, unknown>;
  slug?: string;
  path?: string;
  request_id?: string;
  phase: ManagedSyncFailure['phase'];
  first_seen: string;
  attempts: number;
  /** #6643: what caused this failure (a knock-on's root request, or the receipt blocking a checkpoint). */
  root_cause?: ManagedSyncFailure['root_cause'];
}

export interface SyncStatus {
  source_id: string;
  run_id: string | null;
  cursor: { index: number; total: number; pinned_target: string | null; last_advance_at: string | null; done: boolean } | null;
  /** Managed sync page requests of the source committed in the last ten minutes (waived entries are not requests). */
  committed_last_10m: number;
  /** #6706: the active `sync` Minions job draining this cursor (its `next` watches it), or null. */
  live_job_id: number | null;
  rate_pages_per_min: number | null;
  eta_seconds: number | null;
  holds: SyncStatusHold[];
  /**
   * #6729: renames whose page identity was not kept and whose pair has no disposition yet (old page soft-deleted with its
   * facts and links, held from the purge), each with its remedy: `gbrain repair rename-identity` preview and apply argv,
   * consent and when the purge hold releases.
   */
  identity_downgrades: import('../sync-identity-downgrades.ts').IdentityDowngradeEntry[];
  last_error: SyncStatusError | null;
  /** Whether anything (a hold or the last error) waits on a person; the first such reason. */
  needs_human: boolean;
  human_reason?: string;
  /** The resume arguments after `gbrain sync` for this source's cursor (its stored options when one exists). */
  resume_argv: string[];
  /**
   * #6643: for a cursor whose checkpoint has not committed, every receipt that would block it now (empty: the next sync
   * commits it). #6712 PR 0: always present; empty when no checkpoint is pending (no cursor, a finished one, or one
   * still before its checkpoint step).
   */
  checkpoint_blockers: Array<{ request_id: string; slug: string; state: string; code: string | null; index: number | null; recovery: boolean; knock_on: boolean }>;
  /** #6643: every managed-sync cursor of the source under its current incarnation, newest first (at most 20). */
  cursors: SyncStatusCursor[];
  /** #6650: the source's terminal write receipts that did not commit, summarized (`terminal-failures.ts`); `unknown` when the bounded read timed out. */
  terminal_failures: SyncTerminalSummary;
  /**
   * #6831: for a Google or GitHub connector source, the error its connector runs keep ending on (null once a run
   * finishes). Connector runs keep no managed-sync cursor, so this never sets `last_error`, the cursor's `next` or `needs_human`.
   */
  connector_last_error: import('./connector-status.ts').ConnectorLastError | null;
  /** #7010: Git effects of the source whose local commit has not reached the remote (retrying or parked on a push code), with the fix; `next` falls back to a parked or conflicted one's fix. */
  git_push_holds: GitPushHold[];
  next: Action | null;
  /**
   * #6712 PR 2 (L5): the source's state in the sync outcome vocabulary (`synced` | `resumable` | `blocked`) and why
   * (`SYNC_STATUS_REASONS`). Never `synced` while a probe this read relies on did not answer.
   */
  state: SyncStatusState;
  reason: SyncStatusReason;
  /** #6712 PR 2: the source's oldest unfinished request (its running one first), bounded; works without a cursor. `unknown` when the read timed out. */
  oldest_blocker: { status: 'ok'; request: { request_id: string; state: string; phase: string | null; step: string | null; lapsed: boolean; blocked_by: { predicate: string; state: string | null; intervention: boolean } | null } | null }
    | { status: 'unknown'; reason: string };
  /** #6712 PR 2: requests of the source still holding a publication recovery record (they hold their root), bounded. */
  recovery: { status: 'ok'; count: number; first: { request_id: string; slug: string; blocked: boolean } | null } | { status: 'unknown'; reason: string };
  /**
   * #6712 PR 2: whether each heavy read ran. A plain `sync status` skips them (the fields keep their types: arrays stay
   * empty, `terminal_failures` reads `unknown`); `not_read` carries the `--detail` command that runs them. An agent never
   * reads an empty skipped field as "none".
   */
  checkpoint_blockers_read: SyncStatusRead;
  cursors_read: SyncStatusRead;
  terminal_failures_read: SyncStatusRead;
  /**
   * #6712 PR 4a: the read-only shadow of the level-triggered pass (sync-convergence.ts), \`dry_run: true\`; a heavy read, so
   * only \`--detail\` runs it (\`convergence_read\`). Null when not read, on a brain that is not managed, or for a company-brain
   * source; \`status: 'unavailable'\` names why a read could not run. No other field's meaning depends on it.
   */
  convergence: import('./sync-convergence.ts').ConvergenceReceipt | { dry_run: true; status: 'unavailable'; code: string; message: string } | null;
  convergence_read: SyncStatusRead;
}
export type SyncStatusState = 'synced' | 'resumable' | 'blocked';
/** Why the source is in its state; one closed list. */
export const SYNC_STATUS_REASONS = ['nothing_pending', 'held_by_design', 'cursor_unfinished', 'live_job', 'last_error', 'holds_actionable', 'recovery_pending', 'request_pending',
  'status_unknown', 'needs_human', 'head_blocked', 'recovery_blocked'] as const;
export type SyncStatusReason = typeof SYNC_STATUS_REASONS[number];
export type SyncStatusRead = { status: 'read' } | { status: 'not_read'; fix: Action };
/** The bound of each default probe (the oldest blocker, the recovery records). */
export const SYNC_STATUS_PROBE_MS = 2_000;

export type SyncTerminalSummary = { status: 'unknown'; reason: string } | {
  status: 'ok'; window_days: number; active_blockers: Array<{ kind: 'recovery' | 'checkpoint'; request_id: string; slug?: string; category: string }>;
  unresolved: { rows: number; distinct_slugs: number; distinct_intents: number; oldest_age_seconds: number | null };
  historical_rows: number; new_last_24h: number; defects: number;
  categories: Array<{ category: string; public_category: PublicCategory; code: string; origin: string | null; rows: number; unresolved: number }>; drill_down: string[];
};

/** #6650: the source's slice of the terminal-failure summary, with PR A's checkpoint blockers passed in rather than recomputed. */
async function terminalSummary(engine: BrainEngine, sourceId: string, blockers: SyncStatus['checkpoint_blockers']): Promise<SyncTerminalSummary & { recovery_next?: Action }> {
  const { readTerminalFailureSummary } = await import('./terminal-failures.ts');
  const summary = await readTerminalFailureSummary(engine, { sourceIds: [sourceId], checkpointBlockers: new Map([[sourceId, blockers ?? []]]) });
  if (summary.status === 'unknown') return { status: 'unknown', reason: summary.reason };
  const s = summary.sources[0];
  const recovery = s?.active_blockers.find(b => b.kind === 'recovery');
  return { status: 'ok', window_days: summary.window_days, ...(recovery ? { recovery_next: recovery.action } : {}),
    active_blockers: (s?.active_blockers ?? []).map(b => ({ kind: b.kind, request_id: b.request_id, ...(b.slug ? { slug: b.slug } : {}), category: b.category })),
    unresolved: { rows: s?.unresolved.rows ?? 0, distinct_slugs: s?.unresolved.distinct_slugs ?? 0, distinct_intents: s?.unresolved.distinct_intents ?? 0, oldest_age_seconds: s?.unresolved.oldest_age_seconds ?? null },
    historical_rows: s?.historical_rows ?? 0, new_last_24h: s?.new_last_24h ?? 0, defects: (s?.defects ?? []).reduce((sum, d) => sum + d.rows, 0),
    categories: (s?.categories ?? []).slice(0, 10).map(c => ({ category: c.category, public_category: c.public_category, code: c.code, origin: c.origin, rows: c.rows, unresolved: c.unresolved })),
    drill_down: ['gbrain', 'sources', 'writer', 'failures', sourceId, '--group-by', 'category', '--json'] };
}

interface CursorHeader { runId: string; index: number; total: number; target: string | null; done?: boolean;
  progress?: { startedAt: number; startIndex: number; lastAt: number; lastIndex: number };
  processingOptions?: { noEmbed?: boolean; noExtract?: boolean; noSchemaPack?: boolean }; syncOptions?: Parameters<typeof managedSyncResumeArgs>[0]['syncOptions'];
  binding?: { worktree_id?: string }; settled?: SyncSettledIndexes;
  pending?: { requestId?: string; intent?: { kind?: string; supersededRequests?: string[]; settled?: SyncSettledIndexes | null } } }

/**
 * The newest cursor a current sync of the source can select: #6518, one recorded under its current incarnation.
 * #6643: the cursor the recorded failure belongs to comes first, so the shown cursor, its error and `next` agree.
 */
async function cursorHeader(engine: BrainEngine, sourceId: string, incarnation: string, failedKey: string | null): Promise<{ header: CursorHeader; key: string } | null> {
  const rows = await engine.executeRaw<{ header: CursorHeader; key: string }>(
    `SELECT completed_keys->0 AS header, fingerprint AS key FROM op_checkpoints WHERE op='managed-sync' AND completed_keys->0->>'sourceId'=$1 AND completed_keys->0->>'incarnation'=$2
      ORDER BY (fingerprint=$3) DESC, updated_at DESC LIMIT 1`, [sourceId, incarnation, failedKey ?? '']);
  return rows[0] ?? null;
}

/** #6518: whether an unfinished cursor of the source stands under an incarnation it no longer has (nothing current resumes it). */
async function retiredCursorStands(engine: BrainEngine, sourceId: string, incarnation: string): Promise<{ first_seen: string } | null> {
  const [row] = await engine.executeRaw<{ first_seen: string }>(`SELECT to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS first_seen FROM op_checkpoints
    WHERE op='managed-sync' AND completed_keys->0->>'sourceId'=$1 AND completed_keys->0->>'incarnation'<>$2 AND COALESCE(completed_keys->0->>'done','false')<>'true' ORDER BY updated_at LIMIT 1`, [sourceId, incarnation]);
  return row ?? null;
}

/**
 * #6377: the verdict of a repair-class hold follows its stored repair state. A fence hold whose state is `manual` (a
 * manual-only reason, a gate rejection, a model failure the run does not retry) or `paid` (spend only the user raises),
 * and a slug-conflict hold the lane decided a person must settle (`merge_recommended`, `content_repair_needs_human`),
 * is `needs_human`: the lane will not act on it again until the file changes. `detail` lets the fault table name the
 * paragraph for the lane's codes when it knows them; otherwise the hold's own code decides.
 */
export function holdVerdict(record: GitHoldRecord, auto: FenceAutoRepair | undefined, now = Date.now()): SyncFaultVerdict {
  const escalation = holdEscalation(record, now);
  const content = record.meta.content_repair ? { content_repair: { ...record.meta.content_repair, path: record.path, slug: record.slug } } : {};
  if (record.code === 'origin_conflict' && record.meta.reason) return classifySyncFault({ code: record.code, detail: 'origin_conflict_decision', ...escalation });
  const disposition = contentHoldDisposition(record, auto);
  if (disposition.action !== 'listed' || disposition.state === 'owner') return classifySyncFault({ code: record.code, ...escalation, ...content });
  const verdict = classifySyncFault({ code: record.code, ...escalation, detail: disposition.reason, ...content });
  if (verdict.needs_human) return verdict;
  const reason = disposition.state === 'paid'
    ? `Model repair of ${record.path} waits on a setting only the user changes (${disposition.reason}); the hold's fix names it.`
    : `gbrain will not repair ${record.path} by itself (${disposition.reason}); the hold's fix names the exact edit or decision.`;
  return { ...verdict, safe_actions: ['none'], needs_human: true, human_reason: reason };
}

function holdStatus(record: GitHoldRecord, auto?: FenceAutoRepair): SyncStatusHold {
  const attempts = record.meta.attempts ?? 1;
  const verdict = holdVerdict(record, auto);
  const terminal = classifyRecordedFault({ source_id: record.source_id, code: record.code, slug: record.slug });
  const fix = gitHoldFix(record, auto);
  // #6712 PR 2: an abandoned edit is the person's to commit or restore; unblock then finds the file clean and schedules it.
  return { code: record.code, category: terminal.category, public_category: terminal.public_category, slug: record.slug, path: record.path, attempts, held_since: record.held_at, ...verdict,
    retry_after: verdict.safe_actions[0] === 'retry' || verdict.safe_actions[0] === 'retry_when_clean' ? null : 'after the named step',
    fix: verdict.needs_human && record.code === 'worktree_dirty' ? { ...fix, ask_user: true, user_message: verdict.human_reason } : fix };
}

/**
 * `detail` (default true for library callers; the CLI's plain `sync status` passes false) runs the heavy reads: the
 * terminal-failure summary, the checkpoint blocker list and the live-cursor join. Without it each is skipped with its
 * `<field>_read` sibling, and the bounded oldest-blocker and recovery probes still run.
 */
export async function readSyncStatus(engine: BrainEngine, sourceId: string, opts: { detail?: boolean } = {}): Promise<SyncStatus> {
  const detail = opts.detail !== false;
  const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1 AND archived IS NOT TRUE', [sourceId]);
  if (!source) throw Object.assign(new Error(`Source ${sourceId} does not exist.`), { code: 'not_found' });
  const failures = (await readManagedSyncFailures(engine, [sourceId])).filter(failure => failure.code !== 'sync_incomplete');
  const selected = await cursorHeader(engine, sourceId, source.incarnation, failures[0]?.cursor_key ?? null);
  const header = selected?.header ?? null;
  // #7010: the push-hold probe rides this statement, so a source with no held Git effect costs no extra round trip.
  const [committed] = await engine.executeRaw<{ n: number | string; git_push_held: boolean }>(`SELECT count(*) AS n, EXISTS (SELECT 1 FROM persistence_effects e
      WHERE e.source_id=$1 AND e.kind='git' AND e.state IN ('queued','running','failed') AND e.error_code IN ('targets_parked', ${GIT_PUSH_CODES.map(code => `'${code}'`).join(',')})) AS git_push_held
    FROM persistence_requests WHERE source_id=$1 AND state='committed'
    AND intent->>'kind' IN ('managed_sync_import','managed_sync_delete') AND completed_at > now() - interval '10 minutes'`, [sourceId]);
  const records = await observeDirtyEditors(engine, sourceId, source.incarnation,
    ((await readGitSourceHolds(engine, { sourceIds: [sourceId] }))[0]?.holds ?? []).filter(hold => hold.incarnation === source.incarnation));
  const auto = await fenceAutoRepairFor(engine, records);
  const holds = records.map(record => holdStatus(record, auto));
  const repairable = records.filter(record => contentHoldDisposition(record, auto).action === 'repair').length;
  // #6643: the shown cursor is the one this failure belongs to whenever that cursor stands, so error and `next` agree.
  const failure = failures[0];
  const reason = typeof failure?.write_error_detail?.reason === 'string' ? failure.write_error_detail.reason : null;
  // #6643: a stop the run itself declared, then the root's recorded cause, then a knock-on, then the lane fault or reason.
  const rootCause = failure?.root_cause;
  const laneFault = failure?.code === 'knock_on_exhausted' ? null
    : (failure && cursorFenceCause(failure.write_error_detail) !== 'window_dropped' ? cursorFenceCause(failure.write_error_detail) : null)
      ?? (rootCause?.cause === 'outside_fence' || rootCause?.cause === 'run_replaced' ? rootCause.cause : null)
      ?? (rootCause && failure && ['cancelled', 'revision_conflict'].includes(failure.code) ? 'knock_on' : null)
      ?? (failure?.code === 'cancelled' ? laneFaultInMessage(failure.message) : null) ?? reason;
  const retired = failure || header ? null : await retiredCursorStands(engine, sourceId, source.incarnation);
  const repairPreview: Action = { argv: ['gbrain', 'repair', 'managed-sync-orphans', '--source', sourceId], consent: [], actor: 'agent', requires_exclusive: false,
    why: 'Previews the sync bookkeeping nothing current can resume or clear (an old incarnation\'s cursor and failure rows, stale mirror rows) with the hash its --apply takes; writes nothing.' };
  const recorded = failure ? classifyRecordedFault({ source_id: sourceId, code: failure.code, request_id: failure.request_id, error_detail: failure.write_error_detail ?? null, message: failure.message }) : null;
  const lastError: SyncStatusError | null = failure ? { code: failure.code, category: recorded!.category, public_category: recorded!.public_category,
    ...(laneFault ? { detail: laneFault } : {}), message: failure.message, ...(failure.write_error_detail ? { write_error_detail: failure.write_error_detail } : {}),
    path: failure.path, phase: failure.phase, first_seen: failure.first_seen, attempts: failure.attempts,
    ...(failure.request_id ? { request_id: failure.request_id } : {}), ...(rootCause ? { root_cause: rootCause } : {}),
    ...classifySyncFault({ code: failure.code, detail: laneFault, message: failure.message }) }
    : retired ? { code: 'cursor_incarnation_retired', category: 'sync_fault', public_category: 'superseded', message: `An unfinished sync cursor of ${sourceId} was recorded under an incarnation the source no longer has; no current sync selects it, and it says nothing about whether the current files are imported. `
      + `Retire it with ${repairPreview.argv!.join(' ')} (preview, then --apply with the printed hash).`, phase: 'resume', first_seen: retired.first_seen, attempts: 1, ...classifySyncFault({ code: 'cursor_incarnation_retired' }) } : null;
  const unfinished = !!header && !header.done;
  const remaining = header ? Math.max(0, Number(header.total) - Number(header.index)) : null;
  const p = header?.progress;
  const estimate = unfinished && p ? drainEstimate(remaining, p.lastIndex - p.startIndex, p.lastAt - p.startedAt) : { rate_pages_per_min: null, eta_seconds: null };
  const resume = managedSyncResumeArgs({ sourceId, processingOptions: header?.processingOptions, syncOptions: header?.syncOptions });
  const human = holds.find(hold => hold.needs_human) ?? (lastError?.needs_human ? lastError : undefined);
  // #6643: a knock-on or a superseded run is not a failure of its page: the resume re-freezes the entry.
  const selfHealing = lastError?.detail === 'knock_on' || lastError?.detail === 'run_replaced';
  const actionable = holds.filter(hold => !hold.needs_human && hold.safe_actions[0] !== 'none');
  const verify = { argv: ['gbrain', 'sync', 'status', '--source', sourceId, '--json'] };
  // #6706: a live sync job already drains this cursor; the agent watches it instead of starting a second drainer beside it.
  const liveJob = unfinished && !human ? await (await import('./sync-movement.ts')).liveSyncJob(engine, sourceId) : null;
  const next: Action | null = liveJob !== null
    ? { argv: ['gbrain', 'jobs', 'get', String(liveJob), '--json'], consent: [], actor: 'agent', requires_exclusive: false, verify,
      why: `Sync job #${liveJob} is draining this cursor (${header!.index}/${header!.total}); it resumes the frozen manifest on its own, so watch it rather than running a second sync beside it.` }
    : human
    ? { ...('fix' in human ? human.fix : { argv: ['gbrain', 'sources', 'status', sourceId, '--json'], consent: [], actor: 'host_admin' as const, requires_exclusive: false, why: human.human_reason ?? '' }),
      user_message: `Sync of source ${sourceId} needs a decision: ${'slug' in human && human.slug ? `page ${human.slug} (${('path' in human ? human.path : undefined) ?? ''})` : `code ${human.code}`}: ${human.human_reason ?? 'see the hold'}` }
    : actionable.length
      ? { argv: ['gbrain', 'sync', 'unblock', '--source', sourceId, '--apply', '--json'], consent: [], actor: 'agent', requires_exclusive: false, verify,
        why: `${actionable.length} held file(s) have a safe action: unblock schedules each one whose condition holds (a committed edit, a stalled preparation) for a re-screen`
          + `${repairable ? `, repairs the ${repairable} content hold(s) the content-repair lane clears (hash-bound repairs under the fences.repair caps, one receipt per file, then the re-screen)` : ''}`
          + ' and names the sync to run; it refuses the rest by name and drops nothing.' }
      : retired ? { ...repairPreview, verify }
      : unfinished || lastError
        ? { argv: ['gbrain', 'sync', ...resume], consent: [], actor: 'agent', requires_exclusive: false, verify,
          why: lastError && selfHealing ? `The last run stopped on a page that only waited on another page of the same sync (${lastError.detail}); the same sync re-freezes it under a fresh request${lastError.root_cause?.request_id ? `, and request ${lastError.root_cause.request_id} is what it waited on` : ''}.`
            : lastError ? `The last run recorded ${lastError.code} (${lastError.class}); the same sync retries it: it holds or re-freezes the stopped entry in place, or rediscovers the source from HEAD.`
            : `The cursor stands at ${header!.index}/${header!.total}; the same command resumes it against the frozen manifest.` }
        : null;
  const [oldest, recovery] = await Promise.all([oldestBlocker(engine, sourceId), recoveryProbe(engine, sourceId)]);
  const notRead = (field: string): { status: 'not_read'; fix: Action } => ({ status: 'not_read', fix: { argv: ['gbrain', 'sync', 'status', '--source', sourceId, '--detail', '--json'], consent: [], actor: 'agent',
    requires_exclusive: false, why: `This status skipped the ${field} read (a heavy read); --detail runs it. Read-only.` } });
  const blockers = detail ? await checkpointBlockers(engine, header) : { checkpoint_blockers: [] };
  // #6650: a receipt still holding a recovery record holds its root, so a source with nothing else to do names it as `next`.
  const { recovery_next, ...terminal } = detail ? await terminalSummary(engine, sourceId, blockers.checkpoint_blockers)
    : { status: 'unknown' as const, reason: 'not_read: run sync status with --detail', recovery_next: recovery.status === 'ok' && recovery.first ? recoveryAction(sourceId, recovery.first) : undefined };
  const connectorLastError = await (await import('./connector-status.ts')).readConnectorLastError(engine, sourceId);
  const gitPushHolds = committed?.git_push_held ? await readGitPushHolds(engine, [sourceId]) : [];
  const [state, stateReason] = statusState({ human: !!human, oldest, recovery, liveJob: liveJob !== null, unfinished, lastError: !!lastError, actionable: actionable.length > 0, holds: holds.length > 0 });
  return { source_id: sourceId, run_id: header?.runId ?? null,
    cursor: header ? { index: Number(header.index), total: Number(header.total), pinned_target: header.target ?? null, last_advance_at: p ? new Date(p.lastAt).toISOString() : null, done: !!header.done } : null,
    committed_last_10m: Number(committed?.n ?? 0), ...estimate, live_job_id: liveJob, holds, identity_downgrades: await withIdentityRemedies(engine, await listIdentityDowngrades(engine, [sourceId])), last_error: lastError, needs_human: !!human, ...(human ? { human_reason: human.human_reason } : {}),
    resume_argv: resume, ...blockers, cursors: detail ? await liveCursors(engine, sourceId, source.incarnation, selected?.key ?? null, failures) : [],
    terminal_failures: terminal, connector_last_error: connectorLastError, git_push_holds: gitPushHolds, next: next ?? recovery_next ?? (stateReason === 'request_pending' && oldest.status === 'ok' && oldest.request ? { argv: ['gbrain', 'sync', ...resume], consent: [], actor: 'agent', requires_exclusive: false, verify,
      why: `Write request ${oldest.request.request_id} of this source is still ${oldest.request.state}${oldest.request.step ? ` (step ${oldest.request.step})` : ''}; a running owner finishes it on its own, and the next sync of this source drains it.` } satisfies Action
      : stateReason === 'status_unknown' ? { argv: ['gbrain', 'sync', 'status', '--source', sourceId, '--json'], consent: [], actor: 'agent', requires_exclusive: false, verify,
      why: `The oldest-blocker or recovery probe did not answer within ${SYNC_STATUS_PROBE_MS / 1000} s, so this status does not know the state (it is not reported synced). Rerun it after a short wait; gbrain doctor --json checks the database if it keeps timing out.` } satisfies Action
      : gitPushHolds.find(hold => hold.conflict || hold.parked)?.fix ?? null),
    state, reason: stateReason,
    oldest_blocker: oldest, recovery, checkpoint_blockers_read: detail ? { status: 'read' } : notRead('checkpoint blocker list'),
    cursors_read: detail ? { status: 'read' } : notRead('live cursor'), terminal_failures_read: detail ? { status: 'read' } : notRead('terminal-failure summary'),
    convergence: detail ? await (await import('./sync-pass.ts')).statusConvergence(engine, sourceId) : null, convergence_read: detail ? { status: 'read' } : notRead('convergence shadow') };
}

/** #6712 PR 2: the state and its reason, from what this read saw; a probe that did not answer never yields `synced`. */
function statusState(s: { human: boolean; oldest: SyncStatus['oldest_blocker']; recovery: SyncStatus['recovery']; liveJob: boolean; unfinished: boolean; lastError: boolean;
  actionable: boolean; holds: boolean }): [SyncStatusState, SyncStatusReason] {
  if (s.human) return ['blocked', 'needs_human'];
  if (s.recovery.status === 'ok' && s.recovery.first?.blocked) return ['blocked', 'recovery_blocked'];
  if (s.oldest.status === 'ok' && s.oldest.request?.blocked_by?.intervention && s.oldest.request.state === 'queued') return ['blocked', 'head_blocked'];
  if (s.liveJob) return ['resumable', 'live_job'];
  if (s.unfinished) return ['resumable', 'cursor_unfinished'];
  if (s.lastError) return ['resumable', 'last_error'];
  if (s.actionable) return ['resumable', 'holds_actionable'];
  if (s.recovery.status === 'ok' && s.recovery.count > 0) return ['resumable', 'recovery_pending'];
  if (s.oldest.status === 'ok' && s.oldest.request) return ['resumable', 'request_pending'];
  if (s.oldest.status !== 'ok' || s.recovery.status !== 'ok') return ['resumable', 'status_unknown'];
  return ['synced', s.holds ? 'held_by_design' : 'nothing_pending'];
}

/** #6712 PR 2: the source's oldest unfinished request, read through the drain's own bounded head probe. */
async function oldestBlocker(engine: BrainEngine, sourceId: string): Promise<SyncStatus['oldest_blocker']> {
  const head = engineStallProbe(engine, sourceId).head!;
  try {
    const row = await Promise.race([head(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`no answer within ${SYNC_STATUS_PROBE_MS} ms`)), SYNC_STATUS_PROBE_MS + 1_000).unref?.())]);
    if (!row) return { status: 'ok', request: null };
    return { status: 'ok', request: { request_id: row.write_request_id ?? row.request_id ?? '', state: row.head_state, phase: row.claim?.phase ?? null, step: row.claim?.step ?? null, lapsed: row.claim?.lapsed === true,
      blocked_by: row.blocked_by ? { predicate: row.blocked_by.predicate, state: row.blocked_by.state, intervention: row.blocked_by.intervention } : null } };
  } catch (error) {
    return { status: 'unknown', reason: error instanceof Error ? error.message : String(error) };
  }
}

/** #6712 PR 2: the source's requests holding a publication recovery record, bounded; it needs no cursor. */
async function recoveryProbe(engine: BrainEngine, sourceId: string): Promise<SyncStatus['recovery']> {
  try {
    const rows = await engine.executeRaw<{ n: number | string; request_id: string | null; slug: string | null; blocked: boolean | null }>(
      `SELECT (SELECT count(*) FROM persistence_requests WHERE source_id=$1 AND recovery IS NOT NULL) AS n, f.request_id::text AS request_id, f.slug,
         f.blocked_reason IN ('unexpected_staging_bytes','unexpected_file_bytes') AS blocked
       FROM (SELECT 1) one LEFT JOIN LATERAL (SELECT request_id, slug, blocked_reason FROM persistence_requests WHERE source_id=$1 AND recovery IS NOT NULL ORDER BY sequence LIMIT 1) f ON true`, [sourceId], { timeoutMs: SYNC_STATUS_PROBE_MS, signal: AbortSignal.timeout(SYNC_STATUS_PROBE_MS + 500) });
    const row = rows[0];
    const count = Number(row?.n ?? 0);
    return { status: 'ok', count, first: count && row?.request_id ? { request_id: row.request_id, slug: row.slug ?? '', blocked: row.blocked === true } : null };
  } catch (error) {
    return { status: 'unknown', reason: error instanceof Error ? error.message : String(error) };
  }
}

/** The recovery record's next step, as the terminal-failure summary names it (`classifyTerminal`'s recovery verdict). */
function recoveryAction(sourceId: string, first: { request_id: string; slug: string; blocked: boolean }): Action {
  return classifyTerminal({ request_id: first.request_id, source_id: sourceId, slug: first.slug, operation: 'submit_job', state: 'running', error_code: null, recovery: true,
    blocked_reason: first.blocked ? 'unexpected_file_bytes' : null, compacted: false })!.action;
}

/**
 * #6650: `checkpoint_blockers` of the cursor `readSyncStatus` would show for the source, without the rest of the status
 * (doctor's terminal-failure summary reuses them; it never recomputes the checkpoint's rule).
 */
export async function readCheckpointBlockers(engine: BrainEngine, sourceId: string): Promise<NonNullable<SyncStatus['checkpoint_blockers']>> {
  const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1 AND archived IS NOT TRUE', [sourceId]);
  if (!source) return [];
  const failures = (await readManagedSyncFailures(engine, [sourceId])).filter(failure => failure.code !== 'sync_incomplete');
  const selected = await cursorHeader(engine, sourceId, source.incarnation, failures[0]?.cursor_key ?? null);
  return (await checkpointBlockers(engine, selected?.header ?? null)).checkpoint_blockers;
}

/**
 * #6643: a cursor at its end whose checkpoint has not committed lists every receipt that would block that checkpoint now
 * (the checkpoint's own refusal names only the first), each marked when it is a knock-on; empty means the next sync commits it.
 */
async function checkpointBlockers(engine: BrainEngine, header: CursorHeader | null): Promise<{ checkpoint_blockers: Array<Awaited<ReturnType<typeof listIncompleteSyncReceipts>>[number] & { knock_on: boolean }> }> {
  const intent = header?.pending?.intent;
  if (!header || header.done || intent?.kind !== 'managed_sync_checkpoint' || !header.binding?.worktree_id) return { checkpoint_blockers: [] };
  const rows = await listIncompleteSyncReceipts(engine, header.binding.worktree_id, header.runId, intent.supersededRequests ?? [], intent.settled ?? null);
  const knockOns = new Set(rows.length ? (await engine.executeRaw<{ request_id: string }>(`SELECT request_id::text AS request_id FROM persistence_requests r
    WHERE r.request_id::text = ANY($1::text[]) AND ${syncKnockOnSql('r')}`, [rows.map(row => row.request_id)])).map(row => row.request_id) : []);
  return { checkpoint_blockers: rows.map(row => ({ ...row, recovery: row.recovery === true, knock_on: knockOns.has(row.request_id) })) };
}

/** #6643: one managed-sync cursor of the source (the cursor key digests the writer principal, authority and options, so a source can have several). */
export interface SyncStatusCursor {
  key_prefix: string; run_id: string; index: number; total: number; done: boolean;
  /** The principal whose syncs select this cursor (with matching options). */
  writer: { kind: string; id: string } | null;
  pending: { request_id: string; kind: string | null; state: string | null } | null;
  updated_at: string;
  /** The cursor the top-level `cursor`, `run_id`, `last_error` and `next` describe (the one with the recorded failure, else the newest). */
  shown: boolean;
  /** The code of this cursor's recorded failure, if any. */
  last_error_code: string | null;
  resume_argv: string[];
}

async function liveCursors(engine: BrainEngine, sourceId: string, incarnation: string, shownKey: string | null, failures: Array<{ cursor_key: string; code: string }>): Promise<SyncStatusCursor[]> {
  const rows = await engine.executeRaw<{ fingerprint: string; header: CursorHeader & { authority?: { writer?: { principal?: { kind: string; id: string } } }; pending?: { requestId?: string; intent?: { kind?: string } } };
    updated_at: string; state: string | null }>(
    `SELECT c.fingerprint, c.completed_keys->0 AS header, to_char(c.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at, r.state
       FROM op_checkpoints c LEFT JOIN persistence_requests r ON r.source_id=$1 AND r.request_id::text=c.completed_keys->0->'pending'->>'requestId'
      WHERE c.op='managed-sync' AND c.completed_keys->0->>'sourceId'=$1 AND c.completed_keys->0->>'incarnation'=$2 ORDER BY c.updated_at DESC LIMIT 20`, [sourceId, incarnation]);
  return rows.map(row => ({ key_prefix: row.fingerprint.slice(0, 12), run_id: row.header.runId, index: Number(row.header.index), total: Number(row.header.total), done: !!row.header.done,
    writer: row.header.authority?.writer?.principal ?? null,
    pending: row.header.pending?.requestId ? { request_id: row.header.pending.requestId, kind: row.header.pending.intent?.kind ?? null, state: row.state } : null,
    updated_at: row.updated_at, shown: row.fingerprint === shownKey, last_error_code: failures.find(failure => failure.cursor_key === row.fingerprint)?.code ?? null,
    resume_argv: managedSyncResumeArgs({ sourceId, processingOptions: row.header.processingOptions, syncOptions: row.header.syncOptions }) }));
}

/** #6377: what the content-repair lane did to one held path during `unblock --apply`; codes, tiers and hashes only. */
export interface UnblockRepairOutcome {
  kind: RepairKind;
  /** `repaired` (the write committed, hold cleared or re-screened), `held` (the kind recorded why), `needs_human` (a person decides), `skipped` (not this run: owner, busy, moved, preview). */
  outcome: 'repaired' | 'held' | 'needs_human' | 'skipped';
  /** The kind's reason code for anything but `repaired`. */
  reason?: string;
  tier?: string;
  llm_usd?: number;
  /** The write's location-only receipt fields (mode, tier, classes, hashes, commit state); never content. */
  receipt?: Record<string, unknown>;
  /** The exact next step for this path. */
  next: Action;
}

export type UnblockApplied =
  | { path: string; slug: string | null; code: string; action: 'retry_when_clean' | 'retry'; detail: string }
  | { path: string; slug: string | null; code: string; action: 'repair'; detail: string; repair: UnblockRepairOutcome };

export interface UnblockOutcome {
  source_id: string;
  apply: boolean;
  /** Holds whose safe action ran (or, without --apply, would run). */
  applied: UnblockApplied[];
  /** Holds unblock leaves in place, each with why and the step that clears it. */
  refused: Array<{ path: string; slug: string | null; code: string; reason: string; needs_human: boolean; fix: Action }>;
  /** The sync to run after an apply (the cursor's stored options), or the first refusal's fix when nothing applied. */
  next: Action | null;
}

export interface UnblockOptions {
  apply: boolean;
  /** Today's refuse-only behaviour for repair-class holds. */
  noRepair?: boolean;
  /** Repairs keep to their free tiers. */
  noLlm?: boolean;
  /** The lane's paid allowance for this unblock (undefined: the kinds' own caps). */
  maxLlmUsd?: number;
  /** Replaces the registered repair kinds (tests pass stub specs). */
  registry?: readonly RepairKindSpec[];
}

/** The longest one `unblock --apply` spends repairing; the kinds stop `time_budget` past it and the next unblock resumes. */
export const UNBLOCK_REPAIR_BUDGET_MS = 120_000;

const quiet = { info() {}, warn() {}, error() {} };

/** Location-only fields of a kind's outcome detail (its prose `message` and the legacy commit step are printed, not stored). */
function receiptOf(detail: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!detail) return undefined;
  const { message: _message, commit_step: _step, why: _why, fix: _fix, ...rest } = detail;
  return Object.keys(rest).length ? rest : undefined;
}

/** The sha256 of a held file's uncommitted bytes, when they can be read. */
function workingHashOf(root: string, path: string): { workingHash?: string } {
  try { const bytes = readSyncFile(root, path); return bytes ? { workingHash: sha256(bytes) } : {}; } catch { return {}; }
}

/**
 * #6712 PR 2 (L4): before a `worktree_dirty` hold is called abandoned, its uncommitted bytes are read from the checkout
 * now; bytes that changed since the hold last looked are a live editor (`edited_at` refreshed, no attempt counted), so a
 * hold escalates only when nobody touched the edit for a day. Holds that would not escalate are not read. Status, unblock
 * and the soak sweep all look through this.
 */
export async function observeDirtyEditors(engine: BrainEngine, sourceId: string, incarnation: string, holds: GitHoldRecord[], now = Date.now()): Promise<GitHoldRecord[]> {
  const due = holds.filter(hold => hold.code === 'worktree_dirty' && classifySyncFault({ code: hold.code, ...holdEscalation(hold, now) }).needs_human);
  if (!due.length) return holds;
  const context = await resolveManagedSyncContext(engine, { sourceId, noPull: true }).catch(() => null);
  if (!context) return holds;
  const fresh = new Map<string, GitHoldRecord>();
  for (const hold of due) {
    const { workingHash } = workingHashOf(context.root, hold.path);
    const updated = workingHash === undefined ? null : await noteHoldEdit(engine, { sourceId, incarnation, path: hold.path, workingHash });
    if (updated) fresh.set(hold.path, updated);
  }
  return holds.map(hold => fresh.get(hold.path) ?? hold);
}

/**
 * Performs the safe action for every hold that has one. `retry_when_clean` (`worktree_dirty`): the file is re-screened only
 * when its working-tree bytes are committed at HEAD now; still-dirty files are refused `still_dirty`. `retry`
 * (`preparation_stalled`): scheduled for a re-screen. `repair` (#6377; a hold whose code `CONTENT_REPAIR_HOLD_KINDS` maps to
 * a lane kind, unless `noRepair`): the kind runs on exactly those paths as one bounded apply under its caps (each item bound
 * to the bytes the kind's plan read), each path reports `repaired | held | needs_human | skipped` with the
 * kind's receipt or reason, and repaired paths are scheduled for the re-screen. #6712 PR 2: an applied action that leaves
 * the hold standing (still dirty, a repair that held) counts one failed attempt on the hold. A hold whose attempts reached
 * `HOLD_ATTEMPTS_NEEDS_HUMAN` over `HOLD_ESCALATE_MS`, a `concurrent_write` hold, a repair-class hold whose stored state waits on a person, the
 * user's spend decision or the owner host, and a repair-class hold no lane kind clears yet are refused by name with their
 * fix. Idempotent: scheduling twice is one re-screen, a repaired file is `already_clean` on the next pass, and a preview
 * writes nothing.
 */
export async function unblockSync(engine: BrainEngine, sourceId: string, opts: UnblockOptions): Promise<UnblockOutcome> {
  const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1 AND archived IS NOT TRUE', [sourceId]);
  if (!source) throw Object.assign(new Error(`Source ${sourceId} does not exist.`), { code: 'not_found' });
  const holds = await observeDirtyEditors(engine, sourceId, source.incarnation,
    ((await readGitSourceHolds(engine, { sourceIds: [sourceId] }))[0]?.holds ?? []).filter(hold => hold.incarnation === source.incarnation));
  const [failed] = (await readManagedSyncFailures(engine, [sourceId])).filter(failure => failure.code !== 'sync_incomplete');
  const header = (await cursorHeader(engine, sourceId, source.incarnation, failed?.cursor_key ?? null))?.header;
  const resume = managedSyncResumeArgs({ sourceId, processingOptions: header?.processingOptions, syncOptions: header?.syncOptions });
  const context = holds.some(hold => hold.code === 'worktree_dirty') ? await resolveManagedSyncContext(engine, { sourceId, noPull: true }).catch(() => null) : null;
  const auto = await fenceAutoRepairFor(engine, holds);
  const applied: UnblockOutcome['applied'] = [], refused: UnblockOutcome['refused'] = [];
  const repairs = new Map<RepairKind, GitHoldRecord[]>();
  const verify = { argv: ['gbrain', 'sync', 'status', '--source', sourceId, '--json'] };
  const unblockApply: Action = { argv: ['gbrain', 'sync', 'unblock', '--source', sourceId, '--apply', '--json'], consent: [], actor: 'agent', requires_exclusive: false, verify,
    why: 'Runs the lane kind on this path as a hash-bound apply under the fences.repair caps and schedules the re-screen.' };
  for (const hold of holds) {
    const status = holdStatus(hold, auto);
    const refuse = (reason: string) => refused.push({ path: hold.path, slug: hold.slug, code: hold.code, reason, needs_human: status.needs_human, fix: status.fix });
    if (status.needs_human && hold.code !== 'worktree_dirty') { refuse(status.human_reason ?? 'needs a person'); continue; }
    if (hold.code === 'worktree_dirty') {
      const committed = context ? headCommittedBytes(context, hold.path) : null;
      if (!committed && status.needs_human) { refuse(status.human_reason ?? 'needs a person'); continue; }
      if (!committed) {
        refuse(context ? 'still_dirty: the working-tree bytes are not committed at HEAD yet' : 'checkout_unreadable: the source checkout could not be resolved');
        if (opts.apply && context) await recordHoldAttempt(engine, { sourceId, incarnation: source.incarnation, path: hold.path, code: hold.code, ...workingHashOf(context.root, hold.path) });
        continue;
      }
      applied.push({ path: hold.path, slug: hold.slug, code: hold.code, action: 'retry_when_clean', detail: `committed at HEAD as blob ${committed.oid.slice(0, 12)}; scheduled for a re-screen` });
      continue;
    }
    if (outOfAttemptsHold(hold.code)) {
      applied.push({ path: hold.path, slug: hold.slug, code: hold.code, action: 'retry', detail: `attempt ${(hold.meta.attempts ?? 1) + 1} of ${HOLD_ATTEMPTS_NEEDS_HUMAN}; scheduled for a re-screen` });
      continue;
    }
    const disposition: ContentHoldDisposition = opts.noRepair ? { action: 'unsupported' } : contentHoldDisposition(hold, auto);
    if (disposition.action === 'listed') { refuse(`${disposition.state}: ${disposition.reason}; the content-repair lane will not retry it until the file changes`); continue; }
    if (disposition.action === 'unsupported') { refuse(`${status.safe_actions[0]}: not something unblock performs; run the fix it names`); continue; }
    repairs.set(disposition.kind, [...(repairs.get(disposition.kind) ?? []), hold]);
    if (!opts.apply) {
      applied.push({ path: hold.path, slug: hold.slug, code: hold.code, action: 'repair', detail: `would run gbrain repair ${disposition.kind} on this path under the fences.repair caps; --apply repairs it and schedules the re-screen`,
        repair: { kind: disposition.kind, outcome: 'skipped', reason: 'preview', next: unblockApply } });
    }
  }
  const retry = applied.filter(entry => entry.action !== 'repair').map(entry => entry.path);
  if (opts.apply && repairs.size) {
    const kinds = CONTENT_REPAIR_KINDS.filter(kind => repairs.has(kind));
    const paths = [...repairs.values()].flat().map(hold => hold.path);
    const startedAt = Date.now();
    const lane = await runContentLane(engine, await resolveRepairScope(engine, sourceId), { apply: true, kinds, only: paths, noLlm: opts.noLlm, maxLlmUsd: opts.maxLlmUsd,
      deadline: Date.now() + UNBLOCK_REPAIR_BUDGET_MS, sourceFlag: sourceId, logger: quiet, ...(opts.registry ? { registry: opts.registry } : {}) });
    const after = new Map((((await readGitSourceHolds(engine, { sourceIds: [sourceId] }))[0]?.holds ?? [])).map(hold => [hold.path, hold]));
    const syncNext: Action = { argv: ['gbrain', 'sync', ...resume], consent: [], actor: 'agent', requires_exclusive: false, verify, why: 'Re-imports the repaired file and clears or re-screens its hold.' };
    for (const [kind, records] of repairs) {
      const result: RepairResult | undefined = lane.results.find(r => r.kind === kind);
      const stop = lane.stopped.find(s => s.kind === kind);
      for (const hold of records) {
        const item = result?.outcome_items?.find(o => o.detail?.path === hold.path || (hold.slug !== null && o.item === `${sourceId}:${hold.slug}`));
        const current = after.get(hold.path) ?? hold;
        const fix = gitHoldFix(current, auto);
        // A path the kind planned reports its own outcome; one it kept out of the plan recorded why on the hold (its state decides), or was never reached.
        const state = item?.outcome === 'repaired' ? null : contentHoldDisposition(current, auto);
        const recorded = current.meta.fence_repair && Date.parse(current.meta.fence_repair.at) >= startedAt ? current.meta.fence_repair.reason : undefined;
        const outcome: UnblockRepairOutcome['outcome'] = item?.outcome === 'repaired' ? 'repaired'
          : state?.action === 'listed' ? (state.state === 'needs_human' ? 'needs_human' : 'held')
            : item ? (item.outcome === 'held' ? 'held' : 'skipped') : recorded ? 'held' : 'skipped';
        const reason = outcome === 'repaired' ? undefined : state?.action === 'listed' ? state.reason : item ? item.reason : recorded ?? stop?.reason ?? 'not_planned';
        const detail = item?.detail as Record<string, unknown> | undefined;
        const message = typeof detail?.message === 'string' ? detail.message : undefined;
        const llmUsd = item?.llm_usd;
        if (outcome === 'repaired') retry.push(hold.path);
        else if (outcome === 'held') await recordHoldAttempt(engine, { sourceId, incarnation: source.incarnation, path: hold.path, code: hold.code });
        applied.push({ path: hold.path, slug: hold.slug, code: hold.code, action: 'repair',
          detail: outcome === 'repaired' ? `repaired by gbrain repair ${kind}${typeof detail?.tier === 'string' ? ` (${detail.tier})` : ''}; scheduled for a re-screen`
            : `${outcome} (${reason})${message ? `: ${message}` : !item && stop ? `: ${stop.message}` : ''}`,
          repair: { kind, outcome, ...(reason ? { reason } : {}), ...(typeof detail?.tier === 'string' ? { tier: detail.tier } : {}), ...(llmUsd !== undefined ? { llm_usd: llmUsd } : {}),
            ...(receiptOf(detail) ? { receipt: receiptOf(detail) } : {}), next: outcome === 'repaired' ? syncNext : outcome === 'skipped' && (!item || stop) ? unblockApply : fix } });
      }
    }
  }
  if (opts.apply && retry.length) await requestGitHoldRetry(engine, sourceId, source.incarnation, retry);
  const repaired = applied.filter(entry => entry.action === 'repair' && entry.repair.outcome === 'repaired').length;
  const next: Action | null = applied.length
    ? opts.apply
      ? retry.length
        ? { argv: ['gbrain', 'sync', ...resume], consent: [], actor: 'agent', requires_exclusive: false, verify,
          why: `${retry.length} held file(s) are scheduled for a re-screen${repaired ? ` (${repaired} repaired by the content-repair lane, each with its receipt above)` : ''}; the sync imports each one that now passes and holds again what still fails, without blocking the rest.` }
        : (applied.find((entry): entry is Extract<UnblockApplied, { action: 'repair' }> => entry.action === 'repair')?.repair.next ?? refused[0]?.fix ?? null)
      : { argv: ['gbrain', 'sync', 'unblock', '--source', sourceId, '--apply', '--json'], consent: [], actor: 'agent', requires_exclusive: false, verify,
        why: `${applied.length} held file(s) would be ${repairs.size ? 'repaired or ' : ''}scheduled for a re-screen; nothing was written. --apply ${repairs.size ? 'runs the hash-bound repairs under the fences.repair caps, ' : ''}schedules the re-screens and prints the sync to run.` }
    : refused[0]?.fix ?? null;
  return { source_id: sourceId, apply: opts.apply, applied, refused, next };
}
