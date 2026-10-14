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
import { fenceAutoRepairFor, gitHoldFix, readGitSourceHolds, requestGitHoldRetry, type GitHoldRecord } from './sync-holds.ts';
import type { FenceAutoRepair } from '../fence-repair/hold-fix.ts';
import { classifySyncFault, HOLD_ATTEMPTS_NEEDS_HUMAN, type SyncFaultVerdict } from './sync-fault-class.ts';
import { CONTENT_REPAIR_KINDS, contentHoldDisposition, runContentLane, type ContentHoldDisposition } from '../repair/content-lane.ts';
import { resolveRepairScope, type RepairKind, type RepairResult } from '../repair/core.ts';
import type { RepairKindSpec } from '../repair/registry.ts';
import { headCommittedBytes } from './sync-page-fault.ts';
import { laneFaultInMessage } from './sync-window.ts';
import { cursorFenceCause, syncKnockOnSql } from './sync-knock-on.ts';
import { listIncompleteSyncReceipts, type SyncSettledIndexes } from './checkpoint-validation.ts';
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
  rate_pages_per_min: number | null;
  eta_seconds: number | null;
  holds: SyncStatusHold[];
  last_error: SyncStatusError | null;
  /** Whether anything (a hold or the last error) waits on a person; the first such reason. */
  needs_human: boolean;
  human_reason?: string;
  /** The resume arguments after `gbrain sync` for this source's cursor (its stored options when one exists). */
  resume_argv: string[];
  /** #6643: for a cursor whose checkpoint has not committed, every receipt that would block it now (empty: the next sync commits it). */
  checkpoint_blockers?: Array<{ request_id: string; slug: string; state: string; code: string | null; index: number | null; recovery: boolean; knock_on: boolean }>;
  /** #6643: every managed-sync cursor of the source under its current incarnation, newest first (at most 20). */
  cursors: SyncStatusCursor[];
  next: Action | null;
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
function holdVerdict(record: GitHoldRecord, auto: FenceAutoRepair | undefined): SyncFaultVerdict {
  const attempts = record.meta.attempts ?? 1;
  const content = record.meta.content_repair ? { content_repair: { ...record.meta.content_repair, path: record.path, slug: record.slug } } : {};
  const disposition = contentHoldDisposition(record, auto);
  if (disposition.action !== 'listed' || disposition.state === 'owner') return classifySyncFault({ code: record.code, attempts, ...content });
  const verdict = classifySyncFault({ code: record.code, attempts, detail: disposition.reason, ...content });
  if (verdict.needs_human) return verdict;
  const reason = disposition.state === 'paid'
    ? `Model repair of ${record.path} waits on a setting only the user changes (${disposition.reason}); the hold's fix names it.`
    : `gbrain will not repair ${record.path} by itself (${disposition.reason}); the hold's fix names the exact edit or decision.`;
  return { ...verdict, safe_actions: ['none'], needs_human: true, human_reason: reason };
}

function holdStatus(record: GitHoldRecord, auto?: FenceAutoRepair): SyncStatusHold {
  const attempts = record.meta.attempts ?? 1;
  const verdict = holdVerdict(record, auto);
  return { code: record.code, slug: record.slug, path: record.path, attempts, held_since: record.held_at, ...verdict,
    retry_after: verdict.safe_actions[0] === 'retry' || verdict.safe_actions[0] === 'retry_when_clean' ? null : 'after the named step', fix: gitHoldFix(record, auto) };
}

export async function readSyncStatus(engine: BrainEngine, sourceId: string): Promise<SyncStatus> {
  const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1 AND archived IS NOT TRUE', [sourceId]);
  if (!source) throw Object.assign(new Error(`Source ${sourceId} does not exist.`), { code: 'not_found' });
  const failures = (await readManagedSyncFailures(engine, [sourceId])).filter(failure => failure.code !== 'sync_incomplete');
  const selected = await cursorHeader(engine, sourceId, source.incarnation, failures[0]?.cursor_key ?? null);
  const header = selected?.header ?? null;
  const [committed] = await engine.executeRaw<{ n: number | string }>(`SELECT count(*) AS n FROM persistence_requests WHERE source_id=$1 AND state='committed'
    AND intent->>'kind' IN ('managed_sync_import','managed_sync_delete') AND completed_at > now() - interval '10 minutes'`, [sourceId]);
  const records = ((await readGitSourceHolds(engine, { sourceIds: [sourceId] }))[0]?.holds ?? []).filter(hold => hold.incarnation === source.incarnation);
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
  const lastError: SyncStatusError | null = failure ? { code: failure.code, ...(laneFault ? { detail: laneFault } : {}), message: failure.message, ...(failure.write_error_detail ? { write_error_detail: failure.write_error_detail } : {}),
    path: failure.path, phase: failure.phase, first_seen: failure.first_seen, attempts: failure.attempts,
    ...(failure.request_id ? { request_id: failure.request_id } : {}), ...(rootCause ? { root_cause: rootCause } : {}),
    ...classifySyncFault({ code: failure.code, detail: laneFault, message: failure.message }) }
    : retired ? { code: 'cursor_incarnation_retired', message: `An unfinished sync cursor of ${sourceId} was recorded under an incarnation the source no longer has; no current sync selects it, and it says nothing about whether the current files are imported. `
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
  const next: Action | null = human
    ? { ...('fix' in human ? human.fix : { argv: ['gbrain', 'sources', 'status', sourceId, '--json'], consent: [], actor: 'host_admin' as const, requires_exclusive: false, why: human.human_reason ?? '' }),
      user_message: `Sync of source ${sourceId} needs a decision: ${'slug' in human && human.slug ? `page ${human.slug} (${('path' in human ? human.path : undefined) ?? ''})` : `code ${human.code}`}: ${human.human_reason ?? 'see the hold'}` }
    : actionable.length
      ? { argv: ['gbrain', 'sync', 'unblock', '--source', sourceId, '--apply', '--json'], consent: [], actor: 'agent', requires_exclusive: false, verify,
        why: `${actionable.length} held file(s) have a safe action: unblock schedules each one whose condition holds (a committed edit, a stalled preparation) for a re-screen`
          + `${repairable ? `, repairs the ${repairable} content hold(s) the content-repair lane clears (hash-bound repairs under the fences.repair caps, one receipt per file, then the re-screen)` : ''}`
          + ' and names the sync to run; it refuses the rest by name and drops nothing.' }
      : retired ? { ...repairPreview, verify }
      : unfinished || lastError
        ? { argv: ['gbrain', 'sync', ...resume, ...(lastError ? ['--retry-failed'] : [])], consent: [], actor: 'agent', requires_exclusive: false, verify,
          why: lastError && selfHealing ? `The last run stopped on a page that only waited on another page of the same sync (${lastError.detail}); --retry-failed (or the same sync) re-freezes it under a fresh request${lastError.root_cause?.request_id ? `, and request ${lastError.root_cause.request_id} is what it waited on` : ''}.`
            : lastError ? `The last run recorded ${lastError.code} (${lastError.class}); this release holds or retries it, and --retry-failed converts the stopped entry in place without re-freezing the manifest.`
            : `The cursor stands at ${header!.index}/${header!.total}; the same command resumes it against the frozen manifest.` }
        : null;
  return { source_id: sourceId, run_id: header?.runId ?? null,
    cursor: header ? { index: Number(header.index), total: Number(header.total), pinned_target: header.target ?? null, last_advance_at: p ? new Date(p.lastAt).toISOString() : null, done: !!header.done } : null,
    committed_last_10m: Number(committed?.n ?? 0), ...estimate, holds, last_error: lastError, needs_human: !!human, ...(human ? { human_reason: human.human_reason } : {}),
    resume_argv: resume, ...(await checkpointBlockers(engine, header)), cursors: await liveCursors(engine, sourceId, source.incarnation, selected?.key ?? null, failures), next };
}

/**
 * #6643: a cursor at its end whose checkpoint has not committed lists every receipt that would block that checkpoint now
 * (the checkpoint's own refusal names only the first), each marked when it is a knock-on; empty means the next sync commits it.
 */
async function checkpointBlockers(engine: BrainEngine, header: CursorHeader | null): Promise<{ checkpoint_blockers?: Array<Awaited<ReturnType<typeof listIncompleteSyncReceipts>>[number] & { knock_on: boolean }> }> {
  const intent = header?.pending?.intent;
  if (!header || header.done || intent?.kind !== 'managed_sync_checkpoint' || !header.binding?.worktree_id) return {};
  const rows = await listIncompleteSyncReceipts(engine, header.binding.worktree_id, header.runId, intent.supersededRequests ?? [], intent.settled ?? null, Number(header.total));
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

/**
 * Performs the safe action for every hold that has one. `retry_when_clean` (`worktree_dirty`): the file is re-screened only
 * when its working-tree bytes are committed at HEAD now; still-dirty files are refused `still_dirty`. `retry`
 * (`preparation_stalled`): scheduled for a re-screen. `repair` (#6377; a hold whose code `CONTENT_REPAIR_HOLD_KINDS` maps to
 * a lane kind, unless `noRepair`): the kind runs on exactly those paths as one bounded apply under its caps (each item bound
 * to the bytes the kind's plan read), each path reports `repaired | held | needs_human | skipped` with the
 * kind's receipt or reason, and repaired paths are scheduled for the re-screen. A hold whose attempts reached
 * `HOLD_ATTEMPTS_NEEDS_HUMAN`, a `concurrent_write` hold, a repair-class hold whose stored state waits on a person, the
 * user's spend decision or the owner host, and a repair-class hold no lane kind clears yet are refused by name with their
 * fix. Idempotent: scheduling twice is one re-screen, a repaired file is `already_clean` on the next pass, and a preview
 * writes nothing.
 */
export async function unblockSync(engine: BrainEngine, sourceId: string, opts: UnblockOptions): Promise<UnblockOutcome> {
  const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1 AND archived IS NOT TRUE', [sourceId]);
  if (!source) throw Object.assign(new Error(`Source ${sourceId} does not exist.`), { code: 'not_found' });
  const holds = ((await readGitSourceHolds(engine, { sourceIds: [sourceId] }))[0]?.holds ?? []).filter(hold => hold.incarnation === source.incarnation);
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
