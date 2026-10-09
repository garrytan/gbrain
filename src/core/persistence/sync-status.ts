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
 * hold are scheduled for a re-screen) and refuses the rest by name: refusing is
 * the only way it leaves a page out, and it never drops content. Both are
 * trusted-local readers (the CLI); paths are source-root relative.
 */
import type { BrainEngine } from '../engine.ts';
import type { Action } from '../agent-output.ts';
import { managedSyncResumeArgs } from '../sync-reconcile.ts';
import { readManagedSyncFailures, type ManagedSyncFailure } from './sync-failures.ts';
import { gitHoldFix, readGitSourceHolds, requestGitHoldRetry, type GitHoldRecord } from './sync-holds.ts';
import { classifySyncFault, HOLD_ATTEMPTS_NEEDS_HUMAN, type SyncFaultVerdict } from './sync-fault-class.ts';
import { headCommittedBytes } from './sync-page-fault.ts';
import { drainEstimate } from './sync-drain.ts';
import { resolveManagedSyncContext } from './sync-discovery.ts';

export interface SyncStatusHold extends SyncFaultVerdict {
  code: string;
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
  message: string;
  slug?: string;
  path?: string;
  request_id?: string;
  phase: ManagedSyncFailure['phase'];
  first_seen: string;
  attempts: number;
}

export interface SyncStatus {
  source_id: string;
  run_id: string | null;
  cursor: { index: number; total: number; pinned_target: string | null; last_advance_at: string | null; done: boolean } | null;
  /** Managed sync page requests of the source committed in the last ten minutes (waived entries are not requests). */
  committed_last_10m: number;
  rate_pages_per_min: number | null;
  eta_seconds: number | null;
  holds: SyncStatusHold[];
  last_error: SyncStatusError | null;
  /** Whether anything (a hold or the last error) waits on a person; the first such reason. */
  needs_human: boolean;
  human_reason?: string;
  /** The resume arguments after `gbrain sync` for this source's cursor (its stored options when one exists). */
  resume_argv: string[];
  next: Action | null;
}

interface CursorHeader { runId: string; index: number; total: number; target: string | null; done?: boolean;
  progress?: { startedAt: number; startIndex: number; lastAt: number; lastIndex: number };
  processingOptions?: { noEmbed?: boolean; noExtract?: boolean; noSchemaPack?: boolean }; syncOptions?: Parameters<typeof managedSyncResumeArgs>[0]['syncOptions'] }

async function cursorHeader(engine: BrainEngine, sourceId: string): Promise<CursorHeader | null> {
  const rows = await engine.executeRaw<{ header: CursorHeader }>(
    `SELECT completed_keys->0 AS header FROM op_checkpoints WHERE op='managed-sync' AND completed_keys->0->>'sourceId'=$1 ORDER BY updated_at DESC LIMIT 1`, [sourceId]);
  return rows[0]?.header ?? null;
}

function holdStatus(record: GitHoldRecord): SyncStatusHold {
  const attempts = record.meta.attempts ?? 1;
  const verdict = classifySyncFault({ code: record.code, attempts });
  return { code: record.code, slug: record.slug, path: record.path, attempts, held_since: record.held_at, ...verdict,
    retry_after: verdict.safe_actions[0] === 'retry' || verdict.safe_actions[0] === 'retry_when_clean' ? null : 'after the named step', fix: gitHoldFix(record) };
}

export async function readSyncStatus(engine: BrainEngine, sourceId: string): Promise<SyncStatus> {
  const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1 AND archived IS NOT TRUE', [sourceId]);
  if (!source) throw Object.assign(new Error(`Source ${sourceId} does not exist.`), { code: 'not_found' });
  const header = await cursorHeader(engine, sourceId);
  const [committed] = await engine.executeRaw<{ n: number | string }>(`SELECT count(*) AS n FROM persistence_requests WHERE source_id=$1 AND state='committed'
    AND intent->>'kind' IN ('managed_sync_import','managed_sync_delete') AND completed_at > now() - interval '10 minutes'`, [sourceId]);
  const holds = ((await readGitSourceHolds(engine, { sourceIds: [sourceId] }))[0]?.holds ?? []).filter(hold => hold.incarnation === source.incarnation).map(holdStatus);
  const failures = (await readManagedSyncFailures(engine, [sourceId])).filter(failure => failure.code !== 'sync_incomplete');
  const failure = failures[0];
  const lastError: SyncStatusError | null = failure ? { code: failure.code, message: failure.message, path: failure.path, phase: failure.phase, first_seen: failure.first_seen, attempts: failure.attempts,
    ...(failure.request_id ? { request_id: failure.request_id } : {}), ...classifySyncFault({ code: failure.code, message: failure.message }) } : null;
  const unfinished = !!header && !header.done;
  const remaining = header ? Math.max(0, Number(header.total) - Number(header.index)) : null;
  const p = header?.progress;
  const estimate = unfinished && p ? drainEstimate(remaining, p.lastIndex - p.startIndex, p.lastAt - p.startedAt) : { rate_pages_per_min: null, eta_seconds: null };
  const resume = managedSyncResumeArgs({ sourceId, processingOptions: header?.processingOptions, syncOptions: header?.syncOptions });
  const human = holds.find(hold => hold.needs_human) ?? (lastError?.needs_human ? lastError : undefined);
  const actionable = holds.filter(hold => !hold.needs_human && hold.safe_actions[0] !== 'none');
  const verify = { argv: ['gbrain', 'sync', 'status', '--source', sourceId, '--json'] };
  const next: Action | null = human
    ? { ...('fix' in human ? human.fix : { argv: ['gbrain', 'sources', 'status', sourceId, '--json'], consent: [], actor: 'host_admin' as const, requires_exclusive: false, why: human.human_reason ?? '' }),
      user_message: `Sync of source ${sourceId} needs a decision: ${'slug' in human && human.slug ? `page ${human.slug} (${('path' in human ? human.path : undefined) ?? ''})` : `code ${human.code}`}: ${human.human_reason ?? 'see the hold'}` }
    : actionable.length
      ? { argv: ['gbrain', 'sync', 'unblock', '--source', sourceId, '--apply', '--json'], consent: [], actor: 'agent', requires_exclusive: false, verify,
        why: `${actionable.length} held file(s) have a safe action: unblock schedules each one whose condition holds (a committed edit, a stalled preparation) for a re-screen and names the sync to run; it refuses the rest by name and drops nothing.` }
      : unfinished || lastError
        ? { argv: ['gbrain', 'sync', ...resume, ...(lastError ? ['--retry-failed'] : [])], consent: [], actor: 'agent', requires_exclusive: false, verify,
          why: lastError ? `The last run recorded ${lastError.code} (${lastError.class}); this release holds or retries it, and --retry-failed converts the stopped entry in place without re-freezing the manifest.`
            : `The cursor stands at ${header!.index}/${header!.total}; the same command resumes it against the frozen manifest.` }
        : null;
  return { source_id: sourceId, run_id: header?.runId ?? null,
    cursor: header ? { index: Number(header.index), total: Number(header.total), pinned_target: header.target ?? null, last_advance_at: p ? new Date(p.lastAt).toISOString() : null, done: !!header.done } : null,
    committed_last_10m: Number(committed?.n ?? 0), ...estimate, holds, last_error: lastError, needs_human: !!human, ...(human ? { human_reason: human.human_reason } : {}),
    resume_argv: resume, next };
}

export interface UnblockOutcome {
  source_id: string;
  apply: boolean;
  /** Holds whose safe action ran (or, without --apply, would run). */
  applied: Array<{ path: string; slug: string | null; code: string; action: 'retry_when_clean' | 'retry'; detail: string }>;
  /** Holds unblock leaves in place, each with why and the step that clears it. */
  refused: Array<{ path: string; slug: string | null; code: string; reason: string; needs_human: boolean; fix: Action }>;
  /** The sync to run after an apply (the cursor's stored options), or the first refusal's fix when nothing applied. */
  next: Action | null;
}

/**
 * Performs the safe action for every hold that has one. `retry_when_clean` (`worktree_dirty`): the file is re-screened only
 * when its working-tree bytes are committed at HEAD now; still-dirty files are refused `still_dirty`. `retry`
 * (`preparation_stalled`): scheduled for a re-screen. A hold whose attempts reached `HOLD_ATTEMPTS_NEEDS_HUMAN`, a
 * `concurrent_write` hold and every repair-class hold are refused by name with their fix. Idempotent: scheduling twice is
 * one re-screen, and nothing here writes a page or clears a hold.
 */
export async function unblockSync(engine: BrainEngine, sourceId: string, opts: { apply: boolean }): Promise<UnblockOutcome> {
  const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1 AND archived IS NOT TRUE', [sourceId]);
  if (!source) throw Object.assign(new Error(`Source ${sourceId} does not exist.`), { code: 'not_found' });
  const holds = ((await readGitSourceHolds(engine, { sourceIds: [sourceId] }))[0]?.holds ?? []).filter(hold => hold.incarnation === source.incarnation);
  const header = await cursorHeader(engine, sourceId);
  const resume = managedSyncResumeArgs({ sourceId, processingOptions: header?.processingOptions, syncOptions: header?.syncOptions });
  const context = holds.some(hold => hold.code === 'worktree_dirty') ? await resolveManagedSyncContext(engine, { sourceId, noPull: true }).catch(() => null) : null;
  const applied: UnblockOutcome['applied'] = [], refused: UnblockOutcome['refused'] = [];
  for (const hold of holds) {
    const status = holdStatus(hold);
    const refuse = (reason: string) => refused.push({ path: hold.path, slug: hold.slug, code: hold.code, reason, needs_human: status.needs_human, fix: status.fix });
    if (status.needs_human) { refuse(status.human_reason ?? 'needs a person'); continue; }
    if (hold.code === 'worktree_dirty') {
      const committed = context ? headCommittedBytes(context, hold.path) : null;
      if (!committed) { refuse(context ? 'still_dirty: the working-tree bytes are not committed at HEAD yet' : 'checkout_unreadable: the source checkout could not be resolved'); continue; }
      applied.push({ path: hold.path, slug: hold.slug, code: hold.code, action: 'retry_when_clean', detail: `committed at HEAD as blob ${committed.oid.slice(0, 12)}; scheduled for a re-screen` });
      continue;
    }
    if (hold.code === 'preparation_stalled') {
      applied.push({ path: hold.path, slug: hold.slug, code: hold.code, action: 'retry', detail: `attempt ${(hold.meta.attempts ?? 1) + 1} of ${HOLD_ATTEMPTS_NEEDS_HUMAN}; scheduled for a re-screen` });
      continue;
    }
    refuse(`${status.safe_actions[0]}: not something unblock performs; run the fix it names`);
  }
  if (opts.apply && applied.length) await requestGitHoldRetry(engine, sourceId, source.incarnation, applied.map(entry => entry.path));
  const verify = { argv: ['gbrain', 'sync', 'status', '--source', sourceId, '--json'] };
  const next: Action | null = applied.length
    ? opts.apply
      ? { argv: ['gbrain', 'sync', ...resume], consent: [], actor: 'agent', requires_exclusive: false, verify,
        why: `${applied.length} held file(s) are scheduled for a re-screen; the sync imports each one that now passes and holds again what still fails, without blocking the rest.` }
      : { argv: ['gbrain', 'sync', 'unblock', '--source', sourceId, '--apply', '--json'], consent: [], actor: 'agent', requires_exclusive: false, verify,
        why: `${applied.length} held file(s) would be scheduled for a re-screen; nothing was written. --apply schedules them and prints the sync to run.` }
    : refused[0]?.fix ?? null;
  return { source_id: sourceId, apply: opts.apply, applied, refused, next };
}
