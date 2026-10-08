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
import type { BrainEngine } from '../engine.ts';
import type { SyncOpts, SyncResult } from '../../commands/sync.ts';
import { OperationError } from '../ops/contract.ts';
import { getCode, isRetryableConnError, isStatementTimeoutError } from '../retry-matcher.ts';
import { currentRunDeadline, noteForwardProgress } from '../forward-progress.ts';
import { serr } from '../console-prefix.ts';
import { ERROR_CATALOGUE, type CatalogueName } from '../error-catalogue.ts';

export type DrainOutcome = 'synced' | 'resumable' | 'blocked';
/** Why a drain ended short of `synced`. Each value has an error-catalogue entry (DX-A4). */
export type DrainStopReason = 'deadline' | 'drain_stalled' | 'database_contention' | 'recovery_required' | 'owner_unavailable'
  | 'writer_lock_unavailable' | 'unexpected_file_bytes' | 'unexpected_staging_bytes' | 'blocked_by_failures';
export interface DrainStall {
  request_id: string;
  state: string;
  blocked_reason: string | null;
  head_request_id: string | null;
  head_state: string | null;
  claimable_here: boolean;
  owner_is_this_host: boolean | null;
  stalled_seconds: number;
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
  /** DX-A5: whether pages were published in bulk groups, and why not when they were not. */
  bulk?: { enabled: boolean; reason: string | null; groups: number; grouped_pages: number; largest_group: number;
    /** #5984 admit-ahead: groups admitted while the previous group was still publishing. */
    admitted_ahead: number;
    /** #5984 lanes: groups published at once, as asked and as in effect at the end, and why fewer. */
    lanes: { configured: number; effective: number; reason: string | null; step_down: string | null; overlapped_groups: number; fallbacks: number } };
}

const TERMINAL_STATUSES = new Set(['synced', 'first_sync', 'up_to_date', 'dry_run']);
const BLOCKED_HEAD_REASONS = new Set(['recovery_required', 'owner_unavailable', 'unexpected_file_bytes', 'unexpected_staging_bytes']);
const PENDING_PAUSE_MS = 250;
const STALL_MS = 30_000;
const STALL_PASSES = 3;
const TRANSIENT_ATTEMPTS = 3;
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
  /** A fingerprint of the awaited request and the worktree head; unchanged across the stall window means no progress. */
  fingerprint(result: SyncResult): Promise<{ key: string; stall: Omit<DrainStall, 'stalled_seconds'> } | null>;
}

export interface DrainInput {
  pass(signal: AbortSignal | undefined, onProgress: NonNullable<SyncOpts['onProgress']>): Promise<SyncResult>;
  signal?: AbortSignal;
  onProgress?: SyncOpts['onProgress'];
  probe?: StallProbe;
  /** Throttled progress lines on stderr (CLI). */
  announce?: boolean;
  /** Publication mode for the report and the start line. */
  bulk?: { enabled: boolean; reason: string | null; lanes?: number; lanesReason?: string | null };
  /** Test seams: the no-progress window, the pause after a pending write and the transient backoff base. */
  stallMs?: number;
  pauseMs?: number;
  backoffMs?: number;
}

/** Re-enter `pass` until the managed cursor is done, the caller stops it, or it is blocked. */
export async function runDrain(input: DrainInput): Promise<SyncResult> {
  const startedAt = Date.now();
  const coop = cooperativeDeadline();
  const signal = coop.signal && input.signal ? AbortSignal.any([input.signal, coop.signal]) : coop.signal ?? input.signal;
  let passes = 0, attempt = 0, readFailures = 0, refreshWaitedMs = 0, written = 0, waived = 0, index = 0, total: number | null = null;
  let announcedStart = false, lastLine = 0, groups = 0, groupedPages = 0, largestGroup = 0, admittedAhead = 0;
  let lanes: { effective: number; stepDown: string | null; overlapped: number; fallbacks: number } | null = null;
  let stall: { key: string; since: number; passes: number } | null = null;
  const remaining = () => total === null ? null : Math.max(0, total - index);
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
    return { ...result, drain: { outcome, ...(stopReason ? { stop_reason: stopReason } : {}), passes, processed: written + waived, written, waived,
      remaining: left, ...drainEstimate(left, written + waived, Date.now() - startedAt),
      ...(input.bulk ? { bulk: { enabled: input.bulk.enabled, reason: input.bulk.reason, groups, grouped_pages: groupedPages, largest_group: largestGroup, admitted_ahead: admittedAhead,
        lanes: { configured: input.bulk.lanes ?? 1, effective: lanes?.effective ?? input.bulk.lanes ?? 1, reason: input.bulk.lanesReason ?? null, step_down: lanes?.stepDown ?? null, overlapped_groups: lanes?.overlapped ?? 0, fallbacks: lanes?.fallbacks ?? 0 } } } : {}), ...extra } };
  };
  try {
    for (;;) {
      passes++;
      let result: SyncResult;
      try {
        result = await input.pass(signal, onProgress);
        attempt = 0;
      } catch (error) {
        const delay = transientDelay(error, ++attempt, refreshWaitedMs, input.backoffMs ?? 250);
        if (delay === null || signal?.aborted) throw error;
        if (error instanceof OperationError && (error.code === 'worktree_refreshing' || error.detail === 'database_contention')) refreshWaitedMs += delay;
        await sleep(delay, signal);
        continue;
      }
      if (!continues(result)) {
        if (TERMINAL_STATUSES.has(result.status)) return finish(result, 'synced');
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
      // #6305: the pass already waited for this write, and no owner process that can take the worktree lock published it.
      if (result.reason === 'writer_pending' && result.managedWrite?.reason === 'writer_lock_unavailable') return finish(result, 'blocked', 'writer_lock_unavailable');
      if (wait?.status === 'read_failed') {
        if (!wait.transient || ++readFailures >= TRANSIENT_ATTEMPTS) return finish(result, 'blocked', 'database_contention');
      } else readFailures = 0;
      if (result.reason === 'writer_pending' && input.probe) {
        const blocked = await input.probe.blockedHead(result);
        if (blocked) return finish(result, 'blocked', blocked.reason, { stall: blocked.stall });
        const print = await input.probe.fingerprint(result);
        if (print) {
          if (!stall || stall.key !== print.key) stall = { key: print.key, since: Date.now(), passes: 0 };
          else if (++stall.passes >= STALL_PASSES && Date.now() - stall.since >= (input.stallMs ?? STALL_MS) && !print.stall.claimable_here) {
            return finish(result, 'blocked', 'drain_stalled', { stall: { ...print.stall, stalled_seconds: Math.round((Date.now() - stall.since) / 1000) } });
          }
        }
      } else stall = null;
      if (result.reason === 'writer_pending') await sleep(input.pauseMs ?? PENDING_PAUSE_MS, signal);
    }
  } finally {
    coop.dispose();
  }
}

/** Engine-backed stall checks: the awaited request, the oldest unfinished request on its worktree, and claimability here. */
export function engineStallProbe(engine: BrainEngine): StallProbe {
  const read = async (result: SyncResult) => {
    const requestId = result.managedWrite?.write_request.request_id;
    if (!requestId) return null;
    const [row] = await engine.executeRaw<{ state: string; updated_at: string; claim_expires_at: string | null; blocked_reason: string | null; recovering: boolean;
      worktree_id: string | null; head_id: string | null; head_state: string | null; head_updated_at: string | null; owner_host_id: string | null }>(
      `SELECT r.state, r.updated_at::text, r.claim_expires_at::text, r.blocked_reason, r.recovery IS NOT NULL AS recovering, r.worktree_id::text,
         h.id::text AS head_id, h.state AS head_state, h.updated_at::text AS head_updated_at, w.owner_host_id::text
       FROM persistence_requests r
       LEFT JOIN persistence_worktrees w ON w.id = r.worktree_id
       LEFT JOIN LATERAL (SELECT e.id, e.state, e.updated_at FROM persistence_requests e WHERE e.worktree_id = r.worktree_id
         AND (e.state IN ('queued','running','recovering') OR e.recovery IS NOT NULL) ORDER BY e.sequence LIMIT 1) h ON r.worktree_id IS NOT NULL
       WHERE r.id = $1::uuid`, [requestId]);
    return row ? { requestId, row } : null;
  };
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
      return { key: [row.state, row.updated_at, row.claim_expires_at, row.blocked_reason, row.head_id, row.head_state, row.head_updated_at].join('|'),
        stall: await describe(found.requestId, row) };
    },
  };
}

/** The managed-sync drain over one engine; the CLI's managed path. */
export async function drainManagedSync(engine: BrainEngine, opts: SyncOpts, announce: boolean): Promise<SyncResult> {
  const { performManagedSync } = await import('./sync-run.ts');
  const { resolveBulkSettings } = await import('./sync-group.ts');
  const drainStartedAt = opts.drainStartedAt ?? Date.now();
  const bulk = await resolveBulkSettings(engine, opts.noBulk, opts.lanes);
  // #5984 lanes: one lane run per drain; its groups carry the id and this process claims them out of FIFO order.
  const laneRun = bulk.enabled && (bulk.lanes ?? 1) > 1 ? randomUUID() : undefined;
  const { closeLaneRun } = await import('./sync-lanes.ts');
  try {
    return await runDrain({ signal: opts.signal, onProgress: opts.onProgress, probe: engineStallProbe(engine), announce,
      bulk: { enabled: bulk.enabled, reason: bulk.reason, lanes: bulk.lanes ?? 1, lanesReason: bulk.lanesReason ?? null },
      pass: (signal, onProgress) => performManagedSync(engine, { ...opts, signal, onProgress, drainStartedAt, ...(bulk.enabled ? { bulk: { ...bulk, laneRun } } : {}) }) });
  } finally {
    if (laneRun) {
      await closeLaneRun(laneRun);
      const { cancelOrphanedLaneRows } = await import('./sync-window.ts');
      await cancelOrphanedLaneRows(engine, laneRun).catch(() => undefined);
    }
  }
}

export interface DrainNext {
  command: string;
  safe_to_loop: boolean;
  retry_after_ms: number;
  eta_seconds: number | null;
  rate_pages_per_min: number | null;
  why: string;
  docs?: string;
}

const STOP_DOCS: Record<DrainStopReason, CatalogueName> = {
  deadline: 'sync_drain_deadline', drain_stalled: 'sync_drain_stalled', database_contention: 'sync_drain_database_contention',
  recovery_required: 'sync_drain_writer_blocked', owner_unavailable: 'sync_drain_writer_blocked', writer_lock_unavailable: 'sync_drain_writer_blocked',
  unexpected_file_bytes: 'sync_drain_writer_blocked',
  unexpected_staging_bytes: 'sync_drain_writer_blocked', blocked_by_failures: 'sync_drain_blocked_by_failures',
};

/** What the agent runs next, or null when the sync is done (DX-A2). */
export function drainNext(result: SyncResult, resumeCommand: string, sourceId: string): DrainNext | null {
  const outcome = syncOutcome(result);
  if (outcome === 'synced') return null;
  const d = result.drain;
  const estimate = { eta_seconds: d?.eta_seconds ?? null, rate_pages_per_min: d?.rate_pages_per_min ?? null };
  const docs = d?.stop_reason ? ERROR_CATALOGUE[STOP_DOCS[d.stop_reason]].docs : undefined;
  if (outcome === 'resumable') {
    return { command: resumeCommand, safe_to_loop: true, retry_after_ms: d?.retry_after_ms ?? 0, ...estimate,
      why: 'The sync stopped at its deadline with its cursor and accepted writes intact; the same command resumes where it stopped.', ...(docs ? { docs } : {}) };
  }
  if (d?.stop_reason === 'database_contention') {
    const wait = result.writeWait?.status === 'read_failed' ? result.writeWait : null;
    return { command: resumeCommand, safe_to_loop: false, retry_after_ms: 0, ...estimate,
      why: `The drain could not read its write's state from the database${wait ? ` (${wait.reason}: ${wait.why})` : ''}. The accepted write keeps its request ID. Fix database access, then rerun.`,
      ...(docs ? { docs } : {}) };
  }
  const writerBlocked = d?.stop_reason && d.stop_reason !== 'blocked_by_failures' && d.stop_reason !== 'deadline';
  if (writerBlocked) {
    return { command: `gbrain sources writer status ${sourceId}`, safe_to_loop: false, retry_after_ms: 0, ...estimate,
      why: d!.stop_reason === 'drain_stalled'
        ? `No write for this source made progress for ${d!.stall?.stalled_seconds ?? 30}s and nothing here can claim it. Inspect the writer, fix what it names, then rerun: ${resumeCommand}`
        : `The source's writer needs intervention (${d!.stop_reason}) before more pages can publish. Inspect it, fix what it names, then rerun: ${resumeCommand}`,
      ...(docs ? { docs } : {}) };
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
  if (d.stall) lines.push(`  Oldest unfinished request ${d.stall.head_request_id ?? d.stall.request_id} (${d.stall.head_state ?? d.stall.state})`
    + `${d.stall.blocked_reason ? `, blocked_reason=${d.stall.blocked_reason}` : ''}; claimable here: ${d.stall.claimable_here ? 'yes' : 'no'}.`);
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
  resume_command: string;
}

/**
 * Unfinished managed cursors with their remaining entries and the rate of
 * their latest drain window (CEO-A18), readable from any process.
 */
export async function readManagedSyncBacklog(engine: BrainEngine, sourceIds?: string[]): Promise<ManagedSyncBacklog[]> {
  const rows = await engine.executeRaw<{ header: { sourceId: string; index: number; total: number; done?: boolean; progress?: { startedAt: number; startIndex: number; lastAt: number; lastIndex: number };
    processingOptions?: { noEmbed?: boolean; noExtract?: boolean; noSchemaPack?: boolean } } }>(
    `SELECT completed_keys->0 AS header FROM op_checkpoints WHERE op='managed-sync' AND COALESCE(completed_keys->0->>'done','false')<>'true'`);
  const flags = { noEmbed: '--no-embed', noExtract: '--no-extract', noSchemaPack: '--no-schema-pack' } as const;
  return rows.map(({ header }) => header).filter(h => h?.sourceId && (!sourceIds || sourceIds.includes(h.sourceId))).map(h => {
    const remaining = Math.max(0, Number(h.total) - Number(h.index));
    const p = h.progress;
    const estimate = p ? drainEstimate(remaining, p.lastIndex - p.startIndex, p.lastAt - p.startedAt) : { rate_pages_per_min: null, eta_seconds: null };
    return { source_id: h.sourceId, index: Number(h.index), total: Number(h.total), remaining, ...estimate,
      last_progress_at: p ? new Date(p.lastAt).toISOString() : null,
      resume_command: `gbrain sync --source ${h.sourceId} --no-pull${(Object.keys(flags) as (keyof typeof flags)[]).filter(k => h.processingOptions?.[k]).map(k => ` ${flags[k]}`).join('')}` };
  });
}

export function formatManagedSyncBacklog(b: ManagedSyncBacklog): string {
  return `${b.source_id}: managed sync cursor at ${b.index}/${b.total} (${b.remaining} remaining`
    + (b.rate_pages_per_min !== null ? `, last drain ${b.rate_pages_per_min} pages/min, indexing ETA ${b.eta_seconds === null ? 'unknown' : formatDuration(b.eta_seconds)}` : ', rate unknown')
    + `). Resume: ${b.resume_command}`;
}
