/**
 * #5984: drain a managed sync to completion in one invocation.
 *
 * `performManagedSync` is single-pass by contract (ENG-A1): it returns
 * `partial / writer_pending` when a page's write outlives its wait and
 * `partial / writer_yield` at a slice boundary. Callers that want a whole
 * catch-up (the CLI, `--all`, `--watch`, the PGLite owner delegate) re-enter it
 * through `runDrain`, which owns the stop rules: the caller's signal and
 * deadline, a cooperative stop before a strict out-of-band deadline, named
 * transient retries, blocked heads and the no-progress detector. Every drain
 * ends in one outcome (`synced`, `resumable`, `blocked`) carried on
 * `SyncResult.drain`; the CLI turns it into the exit code and `next`.
 */
import { randomUUID } from 'node:crypto';
import type { LanesCap } from './sync-group.ts';
import type { BrainEngine } from '../engine.ts';
import type { SyncOpts, SyncResult } from '../../commands/sync.ts';
import { OperationError } from '../ops/contract.ts';
import { getCode, isRetryableConnError, isStatementTimeoutError } from '../retry-matcher.ts';
import { currentRunDeadline, noteForwardProgress } from '../forward-progress.ts';
import { serr } from '../console-prefix.ts';
import { ERROR_CATALOGUE, type CatalogueName } from '../error-catalogue.ts';
import { cliRenderContext, renderAction, type Action, type RenderedAction } from '../agent-output.ts';
import { managedSyncResumeArgs, syncResumeCommand } from '../sync-reconcile.ts';
import { isWriteCapacityWait, outstandingCapacityOf } from './admission-retry.ts';
import { isOwnerThisProcess, stampLastSql, type ClaimLastSql } from './claim-phase.ts';

export type DrainOutcome = 'synced' | 'resumable' | 'blocked';
/** Why a drain ended short of `synced`. Each value has an error-catalogue entry (DX-A4). */
export type DrainStopReason = 'deadline' | 'drain_stalled' | 'database_contention' | 'recovery_required' | 'owner_unavailable'
  | 'unexpected_file_bytes' | 'unexpected_staging_bytes' | 'blocked_by_failures'
  /** #6278: a preparation this process owned outran its budget and allowance; exiting ended it, the same command resumes and the next pass holds the entry if it stalls again. */
  | 'preparation_abandoned'
  /** #6278: the run's breaker tripped on `preparation_stalled` receipts (one systemic diagnostic instead of a pile of holds). */
  | 'preparation_systemic'
  /** #6278 (B7): the sync's next admission was refused for the whole no-progress window because other requests held the writer's outstanding-request cap. */
  | 'write_capacity';
/** #6278 (B7): what the drain waited on when `write_capacity` stopped it: the counts the last refusal carried and how long it waited. */
export interface DrainCapacityWait { outstanding: number | null; limit: number | null; scope: 'principal' | 'brain' | null; waited_seconds: number }
/** #6278: what a stalled head's live claim says it is doing (`claim_phase`, stamped by its owner on every renewal). */
export interface DrainClaim {
  phase: 'preparing' | 'publishing' | null;
  step: string | null;
  waiting_on: 'git' | 'fs' | 'db' | 'pool' | 'unknown' | null;
  /** How long the current phase/step has been in flight, from the stamp; null without a stamp of this claim. */
  step_age_ms: number | null;
  claim_age_ms: number | null;
  /** The lease expired (nobody renews it): a dead owner or a transaction holding the row, never a live preparation. */
  lapsed: boolean;
  /** The owner's pid when it stamped one; this process's pid (and nonce, #6317) means the drain's own consumer holds it. */
  owner_pid: number | null;
  /** #6317: the owner's command kind and per-process nonce from the stamp (null on a stamp from an owner older than #6317). */
  owner_kind: string | null;
  owner_nonce: string | null;
  /** #6317: the last raw statement the owner's preparation issued (label and age), when its stamp recorded one. */
  last_sql: ClaimLastSql | null;
  /** How long a live preparation may hold the head before the drain calls it stalled: its budget plus a grace, capped by the ceiling allowance. */
  allowance_ms: number;
  /** #6317: `persistence.preparation_ceiling_ms`, measured from the claim: past it #6298 frees the root and the drain stops waiting. */
  ceiling_ms: number;
}
/** #6317: what the head owner's heartbeat row (`persistence_consumers`, same host) says about it; null when it wrote none. */
export interface DrainOwnerRow {
  kind: string;
  pid: number;
  nonce: string | null;
  mode: string;
  live: boolean;
  restart_required: boolean;
  root_barrier_age_ms: number | null;
}
export interface DrainStall {
  request_id: string;
  state: string;
  blocked_reason: string | null;
  head_request_id: string | null;
  head_state: string | null;
  claimable_here: boolean;
  owner_is_this_host: boolean | null;
  stalled_seconds: number;
  /** #6278: the head claim's phase, step and wait cause (null when its owner stamped none). */
  phase?: DrainClaim['phase'];
  step?: string | null;
  waiting_on?: DrainClaim['waiting_on'];
  /**
   * #6278: why the drain called it a stall: no renewal (`owner_missing`), a preparation or publication past its allowance, or no change at all.
   * #6317: `owner_wedged_here` is a live same-host owner whose preparation passed the ceiling, or whose own heartbeat row says it is wedged
   * (`restart_required`, a root barrier past the ceiling); `preparation_overdue` is kept for an owner on another host.
   */
  cause?: 'owner_missing' | 'preparation_overdue' | 'publication_overdue' | 'no_progress' | 'owner_wedged_here';
  /** #6317: the head owner as the stamp names it, so the stop can say which process to restart. */
  owner_pid?: number | null;
  owner_kind?: string | null;
  owner_nonce?: string | null;
  last_sql?: ClaimLastSql | null;
  /** #6317: the owner's heartbeat row, when the stop read one (`owner_wedged_here`). */
  owner_row?: DrainOwnerRow | null;
  /** #6317: whether the stop came at the ceiling (true) or on the owner's own wedged verdict before it (false), and the ceiling judged against. */
  past_ceiling?: boolean;
  ceiling_ms?: number;
}
export interface DrainReport {
  outcome: DrainOutcome;
  stop_reason?: DrainStopReason;
  passes: number;
  /** Entries processed by this drain (written + waived). */
  processed: number;
  written: number;
  waived: number;
  remaining: number | null;
  rate_pages_per_min: number | null;
  /** Indexing ETA for the remaining manifest at the observed rate; null while the rate is unknown. */
  eta_seconds: number | null;
  retry_after_ms?: number;
  stall?: DrainStall;
  capacity?: DrainCapacityWait;
  /** DX-A5: whether pages were published in bulk groups, and why not when they were not. */
  bulk?: { enabled: boolean; reason: string | null; groups: number; grouped_pages: number; largest_group: number;
    /** #5984 admit-ahead: groups admitted while the previous group was still publishing. */
    admitted_ahead: number;
    /** #5984 lanes: groups published at once, as asked and as in effect at the end, and why fewer. */
    lanes: LanesReport };
}

/** #5984 lanes: groups published at once (maximum asked, ceiling at start, in effect at the end), and what limited them. */
export interface LanesReport { maximum: number; configured: number; effective: number; reason: string | null; step_down: string | null; overlapped_groups: number; fallbacks: number;
  /** Mean lane transactions open while at least one was, apply time per page, share of lane time spent waiting to commit in order. */
  busy?: number | null; apply_ms_per_page?: number | null; turn_wait_share?: number | null;
  limited_by?: LanesLimit }
/** What held the drain's throughput, and what raises it (none when nothing a setting changes would help). */
export interface LanesLimit { kind: 'lanes_off' | 'database_contention' | 'feeder' | 'pool' | 'maximum'; message: string; raise: string | null }

const TERMINAL_STATUSES = new Set(['synced', 'first_sync', 'up_to_date', 'dry_run']);
const BLOCKED_HEAD_REASONS = new Set(['recovery_required', 'owner_unavailable', 'unexpected_file_bytes', 'unexpected_staging_bytes']);
const PENDING_PAUSE_MS = 250;
const STALL_MS = 30_000;
const STALL_PASSES = 3;
/** #6278: a live preparation may run its budget plus this grace before the drain calls it stalled. */
export const STALL_GRACE_MS = 30_000;
const SYNC_PREPARATION_DEFAULT_MS = 120_000, MAINTENANCE_PREPARATION_DEFAULT_MS = 120_000, PREPARATION_CEILING_DEFAULT_MS = 600_000;
const TRANSIENT_ATTEMPTS = 3;
/** #6278 (B7): the longest pause between admission retries while other requests hold the writer's outstanding cap. */
const CAPACITY_RETRY_MAX_MS = 5_000;
/** #6278 (B7): the page counts of a run a drain finished before yielding for the next one. */
type RunCounts = Pick<SyncResult, 'added' | 'modified' | 'deleted' | 'renamed' | 'chunksCreated'>;
/** The result a drain reports when every pass was refused before it could read its cursor. */
const NO_PASS_RESULT: SyncResult = { status: 'partial', reason: 'writer_pending', fromCommit: null, toCommit: '', added: 0, modified: 0, deleted: 0, renamed: 0, chunksCreated: 0, embedded: 0, pagesAffected: [] };
const REFRESH_WAIT_MS = 5 * 60_000;
const DEADLINE_MARGIN_MS = 15_000;
const PROGRESS_EVERY_MS = 10_000;

function continues(result: SyncResult): boolean {
  return result.status === 'partial' && (result.reason === 'writer_pending' || result.reason === 'writer_yield');
}

/**
 * The outcome of any sync result. A drained result carries its own verdict.
 * A single-pass result with a still-pending managed write keeps the historical
 * failure verdict, because nothing re-enters it.
 */
export function syncOutcome(result: Pick<SyncResult, 'status' | 'reason' | 'managedWrite' | 'drain'>): DrainOutcome {
  if (result.drain) return result.drain.outcome;
  if (TERMINAL_STATUSES.has(result.status)) return 'synced';
  if (result.status === 'blocked_by_failures' || result.managedWrite) return 'blocked';
  if (result.reason === 'pull_failed' || result.reason === 'connector_item_failures' || result.reason === 'connector_partial') return 'blocked';
  return 'resumable';
}

/**
 * Remaining entries, observed rate and indexing ETA. The rate covers only this
 * drain's window, so downtime between runs never depresses it; zero progress
 * means the rate is unknown, never a zero or infinite ETA.
 */
export function drainEstimate(remaining: number | null, processed: number, elapsedMs: number): { rate_pages_per_min: number | null; eta_seconds: number | null } {
  if (processed <= 0 || elapsedMs <= 0) return { rate_pages_per_min: null, eta_seconds: null };
  const perMin = processed / (elapsedMs / 60_000);
  return { rate_pages_per_min: Math.round(perMin * 10) / 10, eta_seconds: remaining === null ? null : Math.ceil(remaining / perMin * 60) };
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const h = Math.floor(seconds / 3600), m = Math.floor(seconds % 3600 / 60);
  return h ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m${String(seconds % 60).padStart(2, '0')}s`;
}

/** Named transient failures the drain retries; anything else ends the drain (CEO-A31). */
function transientDelay(error: unknown, attempt: number, refreshWaitedMs: number, baseMs: number): number | null {
  if (error instanceof OperationError && error.code === 'worktree_refreshing') {
    if (refreshWaitedMs >= REFRESH_WAIT_MS) return null;
    const hinted = Number(/retry_after_ms=(\d+)/.exec(String(error.detail ?? ''))?.[1]);
    return Number.isFinite(hinted) && hinted > 0 ? hinted : 1000;
  }
  // Admission gave up on lock contention (a concurrent publication holds the shared counters); the frozen request ID is kept.
  if (error instanceof OperationError && error.detail === 'database_contention') return refreshWaitedMs >= REFRESH_WAIT_MS ? null : 1000;
  if (attempt > TRANSIENT_ATTEMPTS) return null;
  const contention = error instanceof OperationError && error.code === 'database_contention';
  if (!contention && !isRetryableConnError(error) && !isStatementTimeoutError(error) && getCode(error) !== '57014') return null;
  return baseMs * 4 ** (attempt - 1);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(done, ms);
    function done() { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); }
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** Aborts shortly before a strict out-of-band deadline, so the drain writes the final result instead of the watchdog. */
function cooperativeDeadline(): { signal?: AbortSignal; dispose(): void } {
  const deadline = currentRunDeadline();
  if (!deadline?.strict) return { dispose() {} };
  const remaining = deadline.atMs - Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('run deadline')), Math.max(0, remaining - Math.min(DEADLINE_MARGIN_MS, remaining / 2)));
  timer.unref?.();
  return { signal: controller.signal, dispose: () => clearTimeout(timer) };
}

export interface StallProbe {
  /** A head that needs an operator stops the drain at once; otherwise null. */
  blockedHead(result: SyncResult): Promise<{ reason: DrainStopReason; stall: DrainStall } | null>;
  /**
   * A fingerprint of the awaited request and the worktree head; unchanged across the stall window means no progress.
   * #6278: keyed on state, blocked reason, head id/state and the head claim's phase/step/since, never on the lease
   * columns a renewal bumps, so a renewed-forever claim still reads as no progress. `claim` describes the head's claim.
   */
  fingerprint(result: SyncResult): Promise<{ key: string; stall: Omit<DrainStall, 'stalled_seconds'>; claim?: DrainClaim | null } | null>;
  /** #6278: the source's head while a pass runs (its oldest running request, else its oldest queued one); null when nothing is unfinished. Bounded; may reject. */
  head?(): Promise<{ head_state: string; claim: DrainClaim | null } | null>;
  /** #6317: the head owner's heartbeat row on this host, or null (no row: an older owner, PGLite, the table absent, or another host). Never rejects. */
  owner?(claim: DrainClaim): Promise<DrainOwnerRow | null>;
  /** #6317: whether a consumer here could reclaim a lapsed head: this process's own, or a live full row on this host. Never rejects. */
  reclaimableHere?(): Promise<boolean>;
}

export interface DrainInput {
  pass(signal: AbortSignal | undefined, onProgress: NonNullable<SyncOpts['onProgress']>): Promise<SyncResult>;
  signal?: AbortSignal;
  onProgress?: SyncOpts['onProgress'];
  probe?: StallProbe;
  /** Throttled progress lines on stderr (CLI). */
  announce?: boolean;
  /** Publication mode for the report and the start line. */
  bulk?: { enabled: boolean; reason: string | null; lanes?: number; lanesMax?: number; lanesReason?: string | null; lanesCap?: LanesCap };
  /** Test seams: the no-progress window, the pause after a pending write, the transient backoff base and the progress-line interval. */
  stallMs?: number;
  pauseMs?: number;
  backoffMs?: number;
  progressMs?: number;
}

/**
 * #6278: the line the drain prints while nothing commits, naming the head's step, wait cause and allowance. #6317: past the
 * allowance it names the owner (kind, pid), the last statement and the ceiling the drain waits for (B2, C3).
 */
function stallText(index: number, total: number | null, stalledMs: number, claim: DrainClaim | null, headState: string | null): string {
  const live = !!claim && !claim.lapsed && claim.phase === 'preparing';
  const overdue = live && stalledMs >= claim.allowance_ms;
  const owner = claim?.owner_pid !== null && claim?.owner_pid !== undefined ? `${claim.owner_kind ?? 'owner'} pid ${claim.owner_pid}` : null;
  return `[sync] ${index}/${total ?? '?'} processed · stalled ${Math.round(stalledMs / 1000)}s on ${claim?.step ?? claim?.phase ?? headState ?? 'the writer head'}`
    + `${claim?.waiting_on && claim.waiting_on !== 'unknown' ? ` (waiting on ${claim.waiting_on})` : ''}${claim?.lapsed ? ' (claim lapsed: owner missing)' : ''}`
    + `${overdue && owner ? ` · held by ${owner}` : ''}${overdue && claim.last_sql ? ` · last_sql ${claim.last_sql.label}${claim.last_sql.age_ms === null ? '' : ` ${Math.round(claim.last_sql.age_ms / 1000)}s ago`}` : ''}`
    + `${live ? overdue ? ` · past the ${formatDuration(Math.round(claim.allowance_ms / 1000))} allowance; the root is freed at the ${formatDuration(Math.round(claim.ceiling_ms / 1000))} ceiling`
      : ` · allowed ${formatDuration(Math.round(claim.allowance_ms / 1000))}` : ''}`;
}

/** Re-enter `pass` until the managed cursor is done, the caller stops it, or it is blocked. */
export async function runDrain(input: DrainInput): Promise<SyncResult> {
  const startedAt = Date.now();
  const coop = cooperativeDeadline();
  const signal = coop.signal && input.signal ? AbortSignal.any([input.signal, coop.signal]) : coop.signal ?? input.signal;
  let passes = 0, attempt = 0, readFailures = 0, refreshWaitedMs = 0, written = 0, waived = 0, index = 0, total: number | null = null;
  let announcedStart = false, lastLine = 0, groups = 0, groupedPages = 0, largestGroup = 0, admittedAhead = 0;
  let lanes: { effective: number; stepDown: string | null; overlapped: number; fallbacks: number } | null = null;
  // #6317: `extended` marks the one extra window a lapsed head gets while a consumer here can reclaim it; `ownerAt`/`owner` throttle the owner-row read to one per progress interval.
  let stall: { key: string; since: number; passes: number; claim: DrainClaim | null; stallInfo: Omit<DrainStall, 'stalled_seconds'>; extended?: boolean; ownerAt?: number; owner?: DrainOwnerRow | null } | null = null;
  let lastCommitAt = startedAt, inPass = false, readingHead = false;
  // #6278 (B7): a pass refused for write capacity keeps the last pass's result for the report; `capacity` spans the refusals since the last pass that ran.
  let last: SyncResult | undefined, capacity: { since: number; attempts: number } | null = null;
  // #6278 (B7): a pass may finish one run and yield for the next (re-screens scheduled while it ran); the counts of finished runs carry into the report.
  let carried: RunCounts | null = null;
  const remaining = () => total === null ? null : Math.max(0, total - index);
  const every = input.progressMs ?? PROGRESS_EVERY_MS;
  // #6278: the progress line prints on commits; while nothing commits, a timer names the stall instead of an ETA that assumes none.
  // Between passes the stall comes from the probe's fingerprint; inside a pass (a grouped publish parked in preparation never
  // returns to this loop) the timer reads the source's head claim itself, bounded, and prints nothing when nothing is unfinished.
  const stallLine = input.announce ? setInterval(() => {
    const tickAt = Date.now();
    if (tickAt - lastCommitAt < every || tickAt - lastLine < every) return;
    if (stall) {
      lastLine = tickAt;
      serr(stallText(index, total, Math.max(tickAt - stall.since, stall.claim?.step_age_ms ?? 0), stall.claim, stall.stallInfo.head_state));
      return;
    }
    if (!inPass || !input.probe?.head || readingHead) return;
    readingHead = true;
    const probe = input.probe;
    Promise.resolve().then(() => probe.head!()).then(head => {
      if (!head || !inPass || stall || Date.now() - lastCommitAt < every || tickAt - lastLine < every) return;
      lastLine = tickAt;
      serr(stallText(index, total, head.claim?.step_age_ms ?? Date.now() - lastCommitAt, head.claim, head.head_state));
    }).catch(() => undefined).finally(() => { readingHead = false; });
  }, every) : null;
  stallLine?.unref?.();
  const onProgress: NonNullable<SyncOpts['onProgress']> = event => {
    input.onProgress?.(event);
    if (typeof event.total === 'number') total = event.total;
    if (typeof event.bankedFiles === 'number') index = event.bankedFiles;
    if (event.phase === 'managed_sync.start' && input.announce && !announcedStart) {
      announcedStart = true;
      serr(`[sync] managed catch-up: ${total ?? '?'} entries frozen, ${remaining() ?? '?'} remaining; `
        + (input.bulk?.enabled ? 'publishing in bulk groups (each page keeps its own request).' : `one write request per page${input.bulk?.reason ? ` (bulk off: ${input.bulk.reason})` : ''}.`));
    }
    if (event.phase === 'managed_sync.group' && typeof event.group === 'number') { groups++; groupedPages += event.group; largestGroup = Math.max(largestGroup, event.group); }
    if (event.phase === 'managed_sync.group_ahead') admittedAhead += typeof event.group === 'number' ? 1 : 0;
    if (event.phase === 'managed_sync.lanes' && event.lanes) lanes = { effective: event.lanes.effective, stepDown: event.lanes.stepDown, overlapped: event.lanes.overlapped, fallbacks: event.lanes.fallbacks };
    if (event.phase !== 'managed_sync.page_committed') return;
    if (event.waived) waived++; else written++;
    lastCommitAt = Date.now();
    noteForwardProgress();
    if (input.announce && Date.now() - lastLine >= PROGRESS_EVERY_MS) {
      lastLine = Date.now();
      const estimate = drainEstimate(remaining(), written + waived, Date.now() - startedAt);
      serr(`[sync] ${index}/${total ?? '?'} processed (${written} written, ${waived} waived this run) · `
        + `${estimate.rate_pages_per_min ?? '?'} pages/min · indexing ETA ${estimate.eta_seconds === null ? 'unknown' : formatDuration(estimate.eta_seconds)}`);
    }
  };
  const finish = (result: SyncResult, outcome: DrainOutcome, stopReason?: DrainStopReason, extra?: Partial<DrainReport>): SyncResult => {
    if (result.managedCursor) { index = result.managedCursor.index; total = result.managedCursor.total; }
    const left = outcome === 'synced' ? 0 : remaining();
    if (stopReason === 'deadline' && continues(result)) result = { ...result, reason: 'timeout' };
    if (carried) result = { ...result, added: result.added + carried.added, modified: result.modified + carried.modified, deleted: result.deleted + carried.deleted,
      renamed: result.renamed + carried.renamed, chunksCreated: result.chunksCreated + carried.chunksCreated };
    return { ...result, drain: { outcome, ...(stopReason ? { stop_reason: stopReason } : {}), passes, processed: written + waived, written, waived,
      remaining: left, ...drainEstimate(left, written + waived, Date.now() - startedAt),
      ...(input.bulk ? { bulk: { enabled: input.bulk.enabled, reason: input.bulk.reason, groups, grouped_pages: groupedPages, largest_group: largestGroup, admitted_ahead: admittedAhead,
        lanes: { maximum: input.bulk.lanesMax ?? input.bulk.lanes ?? 1, configured: input.bulk.lanes ?? 1, effective: lanes?.effective ?? input.bulk.lanes ?? 1, reason: input.bulk.lanesReason ?? null,
          step_down: lanes?.stepDown ?? null, overlapped_groups: lanes?.overlapped ?? 0, fallbacks: lanes?.fallbacks ?? 0 } } } : {}), ...extra } };
  };
  try {
    for (;;) {
      passes++;
      let result: SyncResult;
      try {
        inPass = true;
        try { result = await input.pass(signal, onProgress); } finally { inPass = false; }
        attempt = 0; capacity = null;
        if (last?.runId && result.runId && result.runId !== last.runId) {
          const sum: RunCounts = carried ?? { added: 0, modified: 0, deleted: 0, renamed: 0, chunksCreated: 0 };
          carried = { added: sum.added + last.added, modified: sum.modified + last.modified, deleted: sum.deleted + last.deleted, renamed: sum.renamed + last.renamed, chunksCreated: sum.chunksCreated + last.chunksCreated };
        }
        last = result;
      } catch (error) {
        // #6278 (B7): other requests (another writer on the same principal, or the brain) hold the outstanding-request cap, so the pass
        // could not admit its next write. They settle on their own: wait with backoff, say so, and past the no-progress window stop
        // `blocked` with the counts and the writer to inspect, never an uncaught exit without a drain summary.
        if (isWriteCapacityWait(error) && !signal?.aborted) {
          capacity ??= { since: Date.now(), attempts: 0 };
          const counts = outstandingCapacityOf(error), waitedMs = Date.now() - capacity.since;
          if (waitedMs >= (input.stallMs ?? STALL_MS)) return finish(last ?? NO_PASS_RESULT, 'blocked', 'write_capacity', { capacity: { ...counts, waited_seconds: Math.round(waitedMs / 1000) } });
          if (input.announce && Date.now() - lastLine >= every) {
            lastLine = Date.now();
            serr(`[sync] ${index}/${total ?? '?'} processed · waiting for write capacity (${counts.outstanding ?? '?'} outstanding${counts.limit === null ? '' : ` of ${counts.limit}`})`);
          }
          await sleep(Math.min(CAPACITY_RETRY_MAX_MS, (input.backoffMs ?? 250) * 2 ** capacity.attempts++), signal);
          continue;
        }
        const delay = transientDelay(error, ++attempt, refreshWaitedMs, input.backoffMs ?? 250);
        if (delay === null || signal?.aborted) throw error;
        if (error instanceof OperationError && (error.code === 'worktree_refreshing' || error.detail === 'database_contention')) refreshWaitedMs += delay;
        await sleep(delay, signal);
        continue;
      }
      if (!continues(result)) {
        if (TERMINAL_STATUSES.has(result.status)) return finish(result, 'synced');
        // #6278: the breaker's systemic stop is one diagnostic, not a failed page.
        if (result.breaker) return finish(result, 'blocked', 'preparation_systemic');
        if (result.status === 'blocked_by_failures') return finish(result, 'blocked', 'blocked_by_failures');
        if (result.managedWrite && result.managedWrite.write_error !== 'write_pending') return finish(result, 'blocked', 'blocked_by_failures');
        if (result.status === 'partial' && (result.reason === 'timeout' || signal?.aborted)) return finish(result, 'resumable', 'deadline');
        const outcome = syncOutcome({ ...result, drain: undefined });
        return finish(result, outcome, outcome === 'resumable' ? 'deadline' : undefined);
      }
      if (signal?.aborted) return finish(result, 'resumable', 'deadline');
      const wait = result.writeWait;
      if (wait?.status === 'blocked') {
        return finish(result, 'blocked', BLOCKED_HEAD_REASONS.has(wait.cause) ? wait.cause as DrainStopReason : 'recovery_required');
      }
      if (wait?.status === 'read_failed') {
        if (!wait.transient || ++readFailures >= TRANSIENT_ATTEMPTS) return finish(result, 'blocked', 'database_contention');
      } else readFailures = 0;
      if (result.reason === 'writer_pending' && input.probe) {
        const blocked = await input.probe.blockedHead(result);
        if (blocked) return finish(result, 'blocked', blocked.reason, { stall: blocked.stall });
        const print = await input.probe.fingerprint(result);
        if (print) {
          const claim = print.claim ?? null;
          if (!stall || stall.key !== print.key) stall = { key: print.key, since: Date.now(), passes: 0, claim, stallInfo: print.stall };
          else {
            stall.claim = claim; stall.stallInfo = print.stall;
            // #6278: a live preparation (its owner still renews) is allowed its budget plus grace; renewals themselves never count as
            // progress (the key ignores lease columns). A lapsed claim or an unstamped head keeps the plain no-progress window.
            const live = !!claim && !claim.lapsed && claim.phase !== null;
            const window = live ? Math.max(input.stallMs ?? STALL_MS, claim.allowance_ms) : input.stallMs ?? STALL_MS;
            const elapsed = Math.max(Date.now() - stall.since, live ? claim.step_age_ms ?? 0 : 0);
            // #6317 (B2): `claimable_here` no longer gates the stop (it sees queued rows only, and a same-host owner made it always false).
            if (++stall.passes >= STALL_PASSES && elapsed >= window) {
              const cause: DrainStall['cause'] = claim?.lapsed ? 'owner_missing' : live ? claim.phase === 'publishing' ? 'publication_overdue' : 'preparation_overdue' : 'no_progress';
              const detail: DrainStall = { ...print.stall, stalled_seconds: Math.round(elapsed / 1000), phase: claim?.phase ?? null, step: claim?.step ?? null, waiting_on: claim?.waiting_on ?? null, cause,
                owner_pid: claim?.owner_pid ?? null, owner_kind: claim?.owner_kind ?? null, owner_nonce: claim?.owner_nonce ?? null, last_sql: claim?.last_sql ?? null };
              // A preparation this process's own consumer holds past its allowance ends with the process: resumable, and the next pass holds the entry.
              if (cause === 'preparation_overdue' && claim && isOwnerThisProcess({ pid: claim.owner_pid ?? -1, ...(claim.owner_nonce ? { nonce: claim.owner_nonce } : {}) })) {
                return finish(result, 'resumable', 'preparation_abandoned', { stall: detail });
              }
              // #6317: a lapsed head a consumer on this host can reclaim (`head_lapsed` + owner host + a live consumer) gets exactly one more window.
              if (cause === 'owner_missing' && !stall.extended && print.stall.owner_is_this_host !== false && await (input.probe.reclaimableHere?.().catch(() => false) ?? false)) {
                stall.extended = true; stall.since = Date.now(); stall.passes = 0;
              } else if (cause === 'preparation_overdue' && claim && print.stall.owner_is_this_host !== false) {
                // #6317 (B2, G5): a live same-host owner keeps the drain running past the allowance (the stall line names it every interval);
                // the drain stops only past the ceiling, where #6298 frees the root and the next pass holds the entry, or when the owner's own
                // heartbeat row says it is wedged (restart_required, a root barrier past the ceiling). The envelope then says how long until
                // the ceiling (`retry_after_ms`), so a looping caller waits instead of hammering.
                if (stall.ownerAt === undefined || Date.now() - stall.ownerAt >= every) {
                  stall.ownerAt = Date.now();
                  stall.owner = await (input.probe.owner?.(claim).catch(() => null) ?? null);
                }
                const age = claim.claim_age_ms ?? elapsed;
                const pastCeiling = age >= claim.ceiling_ms;
                const wedged = !!stall.owner && (stall.owner.restart_required || (stall.owner.root_barrier_age_ms !== null && stall.owner.root_barrier_age_ms > claim.ceiling_ms));
                if (pastCeiling || wedged) {
                  return finish(result, 'blocked', 'drain_stalled', { stall: { ...detail, cause: 'owner_wedged_here', owner_row: stall.owner ?? null, past_ceiling: pastCeiling, ceiling_ms: claim.ceiling_ms },
                    retry_after_ms: Math.max(0, claim.ceiling_ms - age) });
                }
              } else return finish(result, 'blocked', 'drain_stalled', { stall: detail });
            }
          }
        }
      } else stall = null;
      if (result.reason === 'writer_pending') await sleep(input.pauseMs ?? PENDING_PAUSE_MS, signal);
    }
  } finally {
    coop.dispose();
    if (stallLine) clearInterval(stallLine);
  }
}

/** #6278: the head claim's stamp, as `claim-phase.ts` stores it (fields an older owner never stamped read as null/unknown, never inferred). */
export function drainClaimOf(row: { head_state: string | null; head_claim_phase: unknown; head_token: string | null; head_lapsed: boolean | null; head_kind: string | null },
  budgets: { syncMs: number; maintenanceMs: number; ceilingMs: number }, now = Date.now()): DrainClaim | null {
  if (row.head_state !== 'running') return null;
  const raw = typeof row.head_claim_phase === 'string' ? safeJson(row.head_claim_phase) : row.head_claim_phase;
  const stamp = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null;
  const own = !!stamp && !!row.head_token && stamp.token === row.head_token;
  const age = (at: unknown) => { const ms = typeof at === 'string' ? Date.parse(at) : NaN; return Number.isFinite(ms) ? Math.max(0, now - ms) : null; };
  const budget = String(row.head_kind ?? '').startsWith('managed_sync_') ? budgets.syncMs : budgets.maintenanceMs;
  const phase = own ? stamp!.phase === 'publishing' ? 'publishing' : 'preparing' : null;
  const waiting = own ? stamp!.waiting_on : null;
  const owner = own && stamp!.owner && typeof stamp!.owner === 'object' ? stamp!.owner as Record<string, unknown> : null;
  return { phase, step: own && typeof stamp!.step === 'string' ? stamp!.step : null,
    waiting_on: typeof waiting === 'string' && ['git', 'fs', 'db', 'pool', 'unknown'].includes(waiting) ? waiting as DrainClaim['waiting_on'] : own ? 'unknown' : null,
    step_age_ms: own ? age(stamp!.step_since ?? stamp!.since) : null, claim_age_ms: own ? age(stamp!.claimed_at) : null, lapsed: row.head_lapsed === true,
    owner_pid: own ? ownerPid(stamp!) : null, owner_kind: owner && typeof owner.kind === 'string' ? owner.kind : null, owner_nonce: owner && typeof owner.nonce === 'string' ? owner.nonce : null,
    last_sql: own ? stampLastSql(stamp!.last_sql, now) : null,
    allowance_ms: Math.min(budgets.ceilingMs + STALL_GRACE_MS, budget + STALL_GRACE_MS), ceiling_ms: budgets.ceilingMs };
}
function safeJson(text: string): unknown { try { return JSON.parse(text); } catch { return null; } }
/** The stamp stores the owner as `owner: { kind, pid, version }` (claim-phase.ts); a top-level `pid` is the pre-release shape test fixtures used. */
function ownerPid(stamp: Record<string, unknown>): number | null {
  const owner = stamp.owner && typeof stamp.owner === 'object' ? stamp.owner as Record<string, unknown> : null;
  const pid = owner && typeof owner.pid === 'number' ? owner.pid : stamp.pid;
  return typeof pid === 'number' ? pid : null;
}
/** The preparation budgets the drain's allowance reads (Lane A defines and validates the keys; defaults are the documented ones). */
async function readPreparationBudgets(engine: Pick<BrainEngine, 'getConfig'>): Promise<{ syncMs: number; maintenanceMs: number; ceilingMs: number }> {
  const read = async (key: string, fallback: number) => { const n = Number((await engine.getConfig(key).catch(() => null))?.trim()); return Number.isInteger(n) && n > 0 ? n : fallback; };
  return { syncMs: await read('persistence.sync_preparation_ms', SYNC_PREPARATION_DEFAULT_MS), maintenanceMs: await read('persistence.maintenance_preparation_ms', MAINTENANCE_PREPARATION_DEFAULT_MS),
    ceilingMs: await read('persistence.preparation_ceiling_ms', PREPARATION_CEILING_DEFAULT_MS) };
}

/** The live head read's bound: the ticker must not hang on the lock that stalls the pass it reports on. */
const HEAD_READ_TIMEOUT_MS = 2_000;

/** Engine-backed stall checks: the awaited request, the oldest unfinished request on its worktree, and claimability here; with `sourceId`, the live head read. */
export function engineStallProbe(engine: BrainEngine, sourceId?: string): StallProbe {
  const read = async (result: SyncResult) => {
    const requestId = result.managedWrite?.write_request.request_id;
    if (!requestId) return null;
    const [row] = await engine.executeRaw<{ state: string; blocked_reason: string | null; recovering: boolean;
      worktree_id: string | null; head_id: string | null; head_state: string | null; head_claim_phase: unknown; head_token: string | null; head_lapsed: boolean | null;
      head_kind: string | null; owner_host_id: string | null }>(
      `SELECT r.state, r.blocked_reason, r.recovery IS NOT NULL AS recovering, r.worktree_id::text,
         h.id::text AS head_id, h.state AS head_state, h.claim_phase AS head_claim_phase, h.execution_token::text AS head_token,
         (h.claim_expires_at IS NOT NULL AND h.claim_expires_at < now()) AS head_lapsed, h.intent->>'kind' AS head_kind, w.owner_host_id::text
       FROM persistence_requests r
       LEFT JOIN persistence_worktrees w ON w.id = r.worktree_id
       LEFT JOIN LATERAL (SELECT e.id, e.state, e.claim_phase, e.execution_token, e.claim_expires_at, e.intent FROM persistence_requests e WHERE e.worktree_id = r.worktree_id
         AND (e.state IN ('queued','running','recovering') OR e.recovery IS NOT NULL) ORDER BY e.sequence LIMIT 1) h ON r.worktree_id IS NOT NULL
       WHERE r.id = $1::uuid`, [requestId]);
    return row ? { requestId, row } : null;
  };
  let budgets: Promise<{ syncMs: number; maintenanceMs: number; ceilingMs: number }> | undefined;
  const describe = async (requestId: string, row: NonNullable<Awaited<ReturnType<typeof read>>>['row']): Promise<Omit<DrainStall, 'stalled_seconds'>> => {
    const { localHostId } = await import('./identity.ts');
    const { hasClaimableWrite } = await import('./journal.ts');
    const host = localHostId();
    return { request_id: requestId, state: row.state, blocked_reason: row.blocked_reason, head_request_id: row.head_id, head_state: row.head_state,
      claimable_here: await hasClaimableWrite(engine, host).catch(() => false), owner_is_this_host: row.owner_host_id === null ? null : row.owner_host_id === host };
  };
  return {
    async blockedHead(result) {
      const found = await read(result);
      if (!found) return null;
      const reason = found.row.recovering ? 'recovery_required' : found.row.blocked_reason;
      if (!reason || !BLOCKED_HEAD_REASONS.has(reason)) return null;
      return { reason: reason as DrainStopReason, stall: { ...await describe(found.requestId, found.row), stalled_seconds: 0 } };
    },
    async fingerprint(result) {
      const found = await read(result);
      if (!found) return null;
      const { row } = found;
      const claim = drainClaimOf(row, await (budgets ??= readPreparationBudgets(engine)));
      const stamp = row.head_claim_phase && typeof row.head_claim_phase === 'object' ? row.head_claim_phase as Record<string, unknown> : safeJson(String(row.head_claim_phase ?? '')) as Record<string, unknown> | null;
      // Lease columns (updated_at, claim_expires_at) are deliberately absent: a renewal is not progress.
      return { key: [row.state, row.blocked_reason, row.head_id, row.head_state, claim?.phase ?? '', claim?.step ?? '', stamp?.since ?? '', row.head_lapsed ? 'lapsed' : ''].join('|'),
        stall: await describe(found.requestId, row), claim };
    },
    // #6317: the owner's heartbeat row by pid (and nonce when both sides have one); a consumer here that could reclaim a lapsed head.
    async owner(claim) {
      if (claim.owner_pid === null) return null;
      const { localHostId } = await import('./identity.ts');
      const { listHostConsumers } = await import('./consumer-heartbeat.ts');
      const rows = await listHostConsumers(engine, localHostId()).catch(() => []);
      const row = rows.find(r => r.pid === claim.owner_pid && (claim.owner_nonce === null || r.nonce === claim.owner_nonce));
      return row ? { kind: row.kind, pid: row.pid, nonce: row.nonce, mode: row.mode, live: row.liveness === 'live', restart_required: row.restart_required, root_barrier_age_ms: row.root_barrier_age_ms } : null;
    },
    async reclaimableHere() {
      const { persistenceConsumerStatus } = await import('./service.ts');
      if (persistenceConsumerStatus(engine).state === 'open') return true;
      const { localHostId } = await import('./identity.ts');
      const { listHostConsumers } = await import('./consumer-heartbeat.ts');
      return (await listHostConsumers(engine, localHostId()).catch(() => [])).some(row => (row.mode === 'full' || row.mode === 'promoted') && row.liveness === 'live');
    },
    ...(sourceId ? { async head() {
      const [row] = await engine.executeRaw<{ head_state: string; head_claim_phase: unknown; head_token: string | null; head_lapsed: boolean | null; head_kind: string | null }>(
        `SELECT h.state AS head_state, h.claim_phase AS head_claim_phase, h.execution_token::text AS head_token,
           (h.claim_expires_at IS NOT NULL AND h.claim_expires_at < now()) AS head_lapsed, h.intent->>'kind' AS head_kind
         FROM persistence_source_bindings b
         JOIN sources s ON s.id = b.source_id AND s.incarnation = b.source_incarnation
         JOIN LATERAL (SELECT e.state, e.claim_phase, e.execution_token, e.claim_expires_at, e.intent FROM persistence_requests e
           WHERE e.worktree_id = b.worktree_id AND e.state IN ('queued','running','recovering') ORDER BY (e.state <> 'running'), e.sequence LIMIT 1) h ON true
         WHERE b.source_id = $1`, [sourceId], { timeoutMs: HEAD_READ_TIMEOUT_MS, signal: AbortSignal.timeout(HEAD_READ_TIMEOUT_MS + 500) });
      return row ? { head_state: row.head_state, claim: drainClaimOf(row, await (budgets ??= readPreparationBudgets(engine))) } : null;
    } } : {}),
  };
}

/** The managed-sync drain over one engine; the CLI's managed path. */
export async function drainManagedSync(engine: BrainEngine, opts: SyncOpts, announce: boolean): Promise<SyncResult> {
  const { performManagedSync } = await import('./sync-run.ts');
  const { resolveBulkSettings } = await import('./sync-group.ts');
  const drainStartedAt = opts.drainStartedAt ?? Date.now();
  const { preparationConfigView } = await import('./config-snapshot.ts');
  const bulk = await resolveBulkSettings(await preparationConfigView(engine), opts.noBulk, opts.lanes);
  // #5984 G3: open the pool's connections while the run's startup reads go one at a time, so the waiver screen and
  // the first group do not wait for connection setup.
  if (bulk.enabled) void Promise.all(Array.from({ length: Math.min(8, (bulk.lanes ?? 1) + 2) }, () => engine.executeRaw('SELECT 1').catch(() => undefined)));
  // #5984 lanes: one lane run per drain; its groups carry the id and this process claims them out of FIFO order.
  const laneRun = bulk.enabled && (bulk.lanes ?? 1) > 1 ? randomUUID() : undefined;
  const { closeLaneRun } = await import('./sync-lanes.ts');
  let result: SyncResult | undefined;
  try {
    result = await runDrain({ signal: opts.signal, onProgress: opts.onProgress, probe: engineStallProbe(engine, opts.sourceId), announce,
      bulk: { enabled: bulk.enabled, reason: bulk.reason, lanes: bulk.lanes ?? 1, lanesMax: bulk.lanesMax, lanesReason: bulk.lanesReason ?? null, lanesCap: bulk.lanesCap },
      pass: (signal, onProgress) => performManagedSync(engine, { ...opts, signal, onProgress, drainStartedAt, ...(bulk.enabled ? { bulk: { ...bulk, laneRun } } : {}) }) });
  } finally {
    if (laneRun) {
      const stats = await closeLaneRun(laneRun);
      const { cancelOrphanedLaneRows } = await import('./sync-window.ts');
      await cancelOrphanedLaneRows(engine, laneRun, result?.drain?.outcome === 'blocked' ? 10_000 : 0).catch(() => undefined);
      const lanes = result?.drain?.bulk?.lanes;
      if (lanes && stats) Object.assign(lanes, { busy: stats.busy, apply_ms_per_page: stats.applyMsPerPage, turn_wait_share: stats.turnWaitShare });
    }
  }
  const lanes = result.drain?.bulk?.enabled ? result.drain.bulk.lanes : undefined;
  if (lanes && (result.drain!.written > 0 || lanes.configured === 1)) {
    lanes.limited_by = lanesLimit(lanes, bulk.lanesCap);
    if (announce) serr(`[sync] lanes: ${lanes.effective} of ${lanes.maximum}${lanes.busy != null ? `, ${lanes.busy} busy on average` : ''}; ${lanes.limited_by.message}${lanes.limited_by.raise ? ` ${lanes.limited_by.raise}` : ''}`);
  }
  return result;
}

/**
 * #5984 (E5): what limited a drain's lanes, for the agent. A lock or statement timeout that lowered the lane
 * count comes first, then lanes that were mostly idle (the sync side did not prepare groups fast enough), then
 * the connection pool, then the configured maximum.
 */
export function lanesLimit(lanes: Pick<LanesReport, 'maximum' | 'configured' | 'effective' | 'step_down' | 'busy'>, cap: LanesCap | undefined): LanesLimit {
  if (lanes.configured <= 1) return { kind: 'lanes_off', message: 'lanes are off, so one group publishes at a time.',
    raise: 'Drop --no-lanes, or run gbrain config set sync.lanes 16, to publish groups in parallel.' };
  if (lanes.step_down) return { kind: 'database_contention', message: `lanes stepped down to ${lanes.effective} after ${lanes.step_down}.`,
    raise: 'The database was contended; rerun when it is less busy. No setting raises this.' };
  if (lanes.busy != null && lanes.busy < 0.75 * lanes.effective) return { kind: 'feeder',
    message: `lanes waited for the sync loop to prepare groups (${lanes.busy} of ${lanes.effective} busy on average).`, raise: null };
  if (cap === 'pool') return { kind: 'pool', message: `the connection pool allowed ${lanes.configured} of ${lanes.maximum} lanes.`,
    raise: `Set GBRAIN_POOL_SIZE=${lanes.maximum + 4} for ${lanes.maximum} lanes, if the database has the connections to spare.` };
  return { kind: 'maximum', message: `the configured maximum of ${lanes.maximum} lanes was in use.`,
    raise: lanes.maximum < 16 ? 'Pass gbrain sync --lanes 16, or run gbrain config set sync.lanes 16, to allow more.' : null };
}

export interface DrainNext {
  command: string;
  safe_to_loop: boolean;
  retry_after_ms: number;
  eta_seconds: number | null;
  rate_pages_per_min: number | null;
  why: string;
  docs?: string;
  /**
   * #6317: the stop's code and cause, and its agent-operator fix: while the ceiling is ahead the agent reruns the same command after
   * `retry_after_ms` (`next: run`, `safe_to_loop: true`; `wait` is reserved for provider-side work, agent-output.ts deriveNext);
   * once it passed, `tell_user_to_run` names the owner process to restart.
   */
  code?: string;
  cause?: DrainStall['cause'];
  fix?: RenderedAction;
}

const STOP_DOCS: Record<DrainStopReason, CatalogueName> = {
  deadline: 'sync_drain_deadline', drain_stalled: 'sync_drain_stalled', database_contention: 'sync_drain_database_contention',
  recovery_required: 'sync_drain_writer_blocked', owner_unavailable: 'sync_drain_writer_blocked', unexpected_file_bytes: 'sync_drain_writer_blocked',
  unexpected_staging_bytes: 'sync_drain_writer_blocked', blocked_by_failures: 'sync_drain_blocked_by_failures',
  preparation_abandoned: 'sync_drain_preparation_abandoned', preparation_systemic: 'sync_drain_preparation_systemic', write_capacity: 'sync_drain_write_capacity',
};

/** What the agent runs next, or null when the sync is done (DX-A2). */
export function drainNext(result: SyncResult, resumeCommand: string, sourceId: string): DrainNext | null {
  const outcome = syncOutcome(result);
  if (outcome === 'synced') return null;
  const d = result.drain;
  const estimate = { eta_seconds: d?.eta_seconds ?? null, rate_pages_per_min: d?.rate_pages_per_min ?? null };
  const docs = d?.stop_reason ? ERROR_CATALOGUE[STOP_DOCS[d.stop_reason]].docs : undefined;
  if (outcome === 'resumable') {
    const abandoned = d?.stop_reason === 'preparation_abandoned';
    return { command: resumeCommand, safe_to_loop: true, retry_after_ms: d?.retry_after_ms ?? 0, ...estimate,
      why: abandoned
        ? `A write's preparation outran its budget in this process${d?.stall?.step ? ` (stuck at step ${d.stall.step}${d.stall.waiting_on && d.stall.waiting_on !== 'unknown' ? `, waiting on ${d.stall.waiting_on}` : ''})` : ''}, so the sync exited to end it; `
          + 'its cursor and accepted writes are intact. The same command resumes where it stopped, and an entry that stalls again is held instead of re-entered.'
        : 'The sync stopped at its deadline with its cursor and accepted writes intact; the same command resumes where it stopped.', ...(docs ? { docs } : {}) };
  }
  if (d?.stop_reason === 'preparation_systemic') {
    const breaker = result.breaker;
    return { command: `gbrain sources writer status --source ${sourceId} --json`, safe_to_loop: false, retry_after_ms: 0, ...estimate,
      why: `${breaker?.stalled ?? 'Several'} writes of this sync could not finish preparing${breaker?.step ? ` at step ${breaker.step}` : ''}`
        + `${breaker?.rule === 'consecutive' ? ` (${breaker.consecutive} in a row with no page committed between them)` : ''}, so the run stopped instead of holding every file: the write owner, not the files, `
        + `is the likely cause. Inspect it (read-only), fix what it names or upgrade gbrain, then rerun: ${resumeCommand} (it re-freezes the stopped entry and re-screens the files this run held).`,
      ...(docs ? { docs } : {}) };
  }
  if (d?.stop_reason === 'write_capacity') {
    const c = d.capacity, scope = c?.scope ?? 'principal';
    const key = scope === 'brain' ? 'persistence.limits.brain_outstanding' : 'persistence.limits.principal_outstanding';
    return { command: `gbrain sources writer status --source ${sourceId} --json`, safe_to_loop: false, retry_after_ms: 0, ...estimate,
      why: `The sync could not admit its next write for ${c?.waited_seconds ?? 30}s: ${c?.outstanding ?? 'other'} of the ${scope === 'brain' ? "brain's" : "write principal's"} ${c?.limit ?? ''} outstanding-request slots `
        + 'were in use, most of them by another writer on this host (a maintenance run shares the CLI principal), so there was no room for a sync write. Nothing failed and the cursor is intact. '
        + `Inspect them (read-only) and let them finish, or raise ${key}, then rerun: ${resumeCommand}`,
      ...(docs ? { docs } : {}) };
  }
  if (d?.stop_reason === 'database_contention') {
    const wait = result.writeWait?.status === 'read_failed' ? result.writeWait : null;
    return { command: resumeCommand, safe_to_loop: false, retry_after_ms: 0, ...estimate,
      why: `The drain could not read its write's state from the database${wait ? ` (${wait.reason}: ${wait.why})` : ''}. The accepted write keeps its request ID. Fix database access, then rerun.`,
      ...(docs ? { docs } : {}) };
  }
  // #6317 (B2): a live same-host owner stopped the drain at the ceiling or on its own wedged verdict; the fix is to wait for the ceiling
  // (the root is freed there and the next pass holds the entry) or, past it, to restart the named process.
  if (d?.stop_reason === 'drain_stalled' && d.stall?.cause === 'owner_wedged_here') {
    const stall = d.stall, owner = `${stall.owner_kind ?? 'owner'} pid ${stall.owner_pid ?? '?'}`;
    const where = `${stall.step ? ` at step ${stall.step}` : ''}${stall.waiting_on && stall.waiting_on !== 'unknown' ? `, waiting on ${stall.waiting_on}` : ''}${stall.last_sql ? `, last statement ${stall.last_sql.label}` : ''}`;
    const ahead = !stall.past_ceiling && (d.retry_after_ms ?? 0) > 0;
    const action: Action = ahead
      ? { argv: resumeCommand.split(' '), consent: [], actor: 'agent', requires_exclusive: false,
        why: `The ${owner} on this host still renews the claim; its own budget frees the root at the ceiling in ${formatDuration(Math.ceil((d.retry_after_ms ?? 0) / 1000))}. Rerun this after retry_after_ms (safe in a loop): it resumes the cursor and holds the entry if it stalls again.`,
        verify: { argv: ['gbrain', 'sources', 'writer', 'status', '--source', sourceId, '--json'] } }
      : { argv: ['gbrain', 'sources', 'writer', 'status', '--source', sourceId, '--json'], consent: [], actor: 'host_admin', requires_exclusive: false,
        why: `The ${owner} on this host holds the claim past the ceiling${stall.owner_row?.restart_required ? ' and reports restart_required' : ''}; only restarting that process ends the preparation it is parked in. Status names the request, step and owner, read-only.`,
        user_message: `Restart the gbrain ${stall.owner_kind ?? 'owner'} process (pid ${stall.owner_pid ?? '?'}) on this host, then run: ${resumeCommand}`,
        verify: { argv: ['gbrain', 'sources', 'writer', 'movement', sourceId, '--json'] } };
    return { command: ahead ? resumeCommand : `gbrain sources writer status --source ${sourceId} --json`, safe_to_loop: ahead, retry_after_ms: d.retry_after_ms ?? 0, ...estimate,
      why: `The write at the head of this source has been preparing for ${stall.stalled_seconds}s${where}, held by the ${owner} on this host`
        + `${stall.past_ceiling ? `, past the ${stall.ceiling_ms ? formatDuration(Math.round(stall.ceiling_ms / 1000)) : 'preparation'} ceiling` : stall.owner_row?.restart_required ? ', which reports restart_required' : ', whose heartbeat reports a root barrier past the ceiling'}. `
        + (ahead ? `Wait ${formatDuration(Math.ceil((d.retry_after_ms ?? 0) / 1000))} for the owner's own budget to free the root, then rerun: ${resumeCommand}`
          : `Restart that process, then rerun: ${resumeCommand}`),
      code: 'drain_stalled', cause: 'owner_wedged_here', fix: renderAction(action, cliRenderContext()), ...(docs ? { docs } : {}) };
  }
  const writerBlocked = d?.stop_reason && d.stop_reason !== 'blocked_by_failures' && d.stop_reason !== 'deadline';
  if (writerBlocked) {
    return { command: `gbrain sources writer status ${sourceId}`, safe_to_loop: false, retry_after_ms: 0, ...estimate,
      why: d!.stop_reason === 'drain_stalled'
        ? `No write for this source made progress for ${d!.stall?.stalled_seconds ?? 30}s${d!.stall?.step ? ` (stuck at step ${d!.stall.step}${d!.stall.waiting_on && d!.stall.waiting_on !== 'unknown' ? `, waiting on ${d!.stall.waiting_on}` : ''})` : ''}`
          + `${d!.stall?.cause === 'owner_missing' ? '; its claim lapsed and no consumer here reclaimed it, so its owner is gone or a transaction holds the row' : d!.stall?.cause === 'preparation_overdue' ? `; its owner${d!.stall.owner_pid ? ` (${d!.stall.owner_kind ?? 'process'} pid ${d!.stall.owner_pid} on another host)` : ''} keeps renewing the claim past the preparation budget (an owner that predates deadlines, or one that ignores cancellation)` : ''}`
          + `. Inspect the writer, fix what it names, then rerun: ${resumeCommand}`
        : `The source's writer needs intervention (${d!.stop_reason}) before more pages can publish. Inspect it, fix what it names, then rerun: ${resumeCommand}`,
      ...(d!.stop_reason === 'drain_stalled' ? { code: 'drain_stalled', cause: d!.stall?.cause } : {}), ...(docs ? { docs } : {}) };
  }
  const retry = resumeCommand.includes(' --retry-failed') ? resumeCommand : `${resumeCommand} --retry-failed`;
  return { command: retry, safe_to_loop: false, retry_after_ms: 0, ...estimate,
    why: 'A page failed to publish. Fix the cause named in managed_write / failures first; rerunning without a fix returns the same failure. Ask the user before skipping content.',
    ...(docs ? { docs } : {}) };
}

/** `outcome`, `drain` and `next` for a JSON envelope; empty for results that are not managed syncs. */
export function drainJsonFields(result: SyncResult, resumeCommand: string, sourceId: string): Record<string, unknown> {
  if (!result.drain && !result.managedCursor) return {};
  const next = drainNext(result, resumeCommand, sourceId);
  return { outcome: syncOutcome(result), ...(result.drain ? { drain: result.drain } : {}), ...(next ? { next } : {}) };
}

/** Human lines for the end of a managed sync. */
export function formatDrainSummary(result: SyncResult, resumeCommand: string, sourceId: string): string[] {
  const d = result.drain;
  if (!d) return [];
  const lines = [`Managed sync ${d.outcome}: ${d.processed} entries this run (${d.written} written, ${d.waived} waived)`
    + (d.remaining ? `, ${d.remaining} remaining` : '') + (d.rate_pages_per_min !== null ? `, ${d.rate_pages_per_min} pages/min` : '')
    + (d.remaining && d.eta_seconds !== null ? `, indexing ETA ${formatDuration(d.eta_seconds)}` : '') + '.'];
  if (d.capacity) lines.push(`  Waited ${d.capacity.waited_seconds}s for write capacity: ${d.capacity.outstanding ?? '?'} of ${d.capacity.limit ?? '?'} ${d.capacity.scope ?? 'principal'} outstanding-request slots in use.`);
  // #6317 (C3): the summary line carries the same step / waiting_on / last_sql triple as the log lines, and the owner process.
  if (d.stall) lines.push(`  Oldest unfinished request ${d.stall.head_request_id ?? d.stall.request_id} (${d.stall.head_state ?? d.stall.state})`
    + `${d.stall.blocked_reason ? `, blocked_reason=${d.stall.blocked_reason}` : ''}${d.stall.step ? `, step=${d.stall.step}` : ''}${d.stall.waiting_on ? `, waiting_on=${d.stall.waiting_on}` : ''}`
    + `${d.stall.last_sql ? `, last_sql=${d.stall.last_sql.label}${d.stall.last_sql.age_ms === null ? '' : ` (${Math.round(d.stall.last_sql.age_ms / 1000)}s ago)`}` : ''}`
    + `${d.stall.cause ? `, cause=${d.stall.cause}` : ''}${d.stall.owner_pid ? `, owner=${d.stall.owner_kind ?? 'process'} pid ${d.stall.owner_pid}` : ''}; claimable here: ${d.stall.claimable_here ? 'yes' : 'no'}.`);
  const next = drainNext(result, resumeCommand, sourceId);
  if (next) lines.push(`  Next: ${next.command}${next.safe_to_loop ? ' (safe to rerun in a loop)' : ''}`, `  Why: ${next.why}`);
  return lines;
}

export interface ManagedSyncBacklog {
  source_id: string;
  index: number;
  total: number;
  remaining: number;
  rate_pages_per_min: number | null;
  eta_seconds: number | null;
  last_progress_at: string | null;
  /** #6317: entries this cursor advanced past as holds (no page committed for them). */
  held: number;
  resume_command: string;
  /** #6278: the arguments after `gbrain sync` that resume this cursor with its stored options. */
  resume_args: string[];
}

/**
 * Unfinished managed cursors with their remaining entries and the rate of
 * their latest drain window (CEO-A18), readable from any process.
 */
export async function readManagedSyncBacklog(engine: BrainEngine, sourceIds?: string[]): Promise<ManagedSyncBacklog[]> {
  const rows = await engine.executeRaw<{ header: { sourceId: string; index: number; total: number; done?: boolean; progress?: { startedAt: number; startIndex: number; lastAt: number; lastIndex: number };
    counts?: { held?: number }; processingOptions?: { noEmbed?: boolean; noExtract?: boolean; noSchemaPack?: boolean }; syncOptions?: Parameters<typeof managedSyncResumeArgs>[0]['syncOptions'] } }>(
    `SELECT completed_keys->0 AS header FROM op_checkpoints WHERE op='managed-sync' AND COALESCE(completed_keys->0->>'done','false')<>'true'`);
  return rows.map(({ header }) => header).filter(h => h?.sourceId && (!sourceIds || sourceIds.includes(h.sourceId))).map(h => {
    const remaining = Math.max(0, Number(h.total) - Number(h.index));
    const p = h.progress;
    const estimate = p ? drainEstimate(remaining, p.lastIndex - p.startIndex, p.lastAt - p.startedAt) : { rate_pages_per_min: null, eta_seconds: null };
    const args = managedSyncResumeArgs({ sourceId: h.sourceId, processingOptions: h.processingOptions, syncOptions: h.syncOptions });
    return { source_id: h.sourceId, index: Number(h.index), total: Number(h.total), remaining, ...estimate,
      last_progress_at: p ? new Date(p.lastAt).toISOString() : null, held: Number(h.counts?.held ?? 0), resume_command: syncResumeCommand(args), resume_args: args };
  });
}

export function formatManagedSyncBacklog(b: ManagedSyncBacklog): string {
  return `${b.source_id}: managed sync cursor at ${b.index}/${b.total} (${b.remaining} remaining`
    + (b.rate_pages_per_min !== null ? `, last drain ${b.rate_pages_per_min} pages/min, indexing ETA ${b.eta_seconds === null ? 'unknown' : formatDuration(b.eta_seconds)}` : ', rate unknown')
    + `). Resume: ${b.resume_command}`;
}
