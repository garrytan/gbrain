/**
 * Background extract_atoms drain policy — ONE place for the daily spend cap,
 * brain-wide fairness and "is this source due", shared by autopilot's initial
 * dispatch and the drain handler's continuation so neither can bypass the
 * other.
 *
 *  - Spend: `autopilot.auto_drain.max_usd_per_day` bounds the number of
 *    `extract-atoms-drain` jobs created per UTC day (each run is
 *    BudgetTracker-capped at ~$0.30). Continuations count like any other job.
 *  - Fairness: a continuation may not take a slot another source needs for
 *    its first drain of the day.
 *  - Due: page backlog above the threshold, OR any live transcript (the
 *    transcript pool is not in the page count). No LLM. The transcript side
 *    is a stat-only corpus fingerprint checked against a durable snapshot
 *    (`TRANSCRIPT_BACKLOG_KEY`); the corpus is read (quietly) only when the
 *    fingerprint changed or the snapshot is from an earlier UTC day, and
 *    every drain refreshes the snapshot with its own final count.
 *  - Duplicates: a source with a runnable drain already waiting/active/
 *    delayed, or already dispatched today, is never dispatched again.
 *    Managed-atom retry jobs share the job name but never drain the backlog,
 *    and a paused job may never resume, so neither counts as in flight.
 *  - Races: count-then-submit runs under one DB lock, so autopilot and
 *    concurrent handlers cannot jointly overshoot the cap. The expensive
 *    due-set scan (it may read the transcript corpus) runs BEFORE the lock;
 *    inside it only cheap SQL rechecks run, so the lock is held briefly.
 *  - Fail closed: disabled, a zero budget, or an unknown daily count
 *    dispatches nothing on every path (`budgetVerdict`).
 */

import type { BrainEngine } from '../engine.ts';
import type { MinionQueue } from '../minions/queue.ts';
import { tryAcquireDbLock } from '../db-lock.ts';
import { loadAllSources, sourceLocalPathSkipWarning } from '../sources-load.ts';
import { countExtractAtomsBacklog, countPendingTranscripts, resolveTranscriptCorpusDirs } from './extract-atoms.ts';
import { transcriptCorpusSignature } from './transcript-discovery.ts';

/** Each drain run is BudgetTracker-capped at ~$0.30; the cap counts jobs, not a spend ledger. */
export const AUTO_DRAIN_PER_RUN_USD = 0.3;
const CAP_LOCK_ID = 'extract-atoms-drain-daily-cap';
/** Runnable states only: a paused (or otherwise parked) drain may never run, so it must not suppress one that will. */
const RUNNABLE = ['waiting', 'active', 'delayed'];

export interface AutoDrainPolicy {
  enabled: boolean;
  threshold: number;
  windowSeconds: number;
  maxUsdPerDay: number;
  maxJobsToday: number;
  utcDay: string;
}

export async function readAutoDrainPolicy(engine: BrainEngine, now = new Date()): Promise<AutoDrainPolicy> {
  const posInt = (v: string | null, d: number) => {
    const n = v == null ? NaN : parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  const nonNegFloat = (v: string | null, d: number) => {
    const n = v == null ? NaN : parseFloat(v);
    return Number.isFinite(n) && n >= 0 ? n : d;
  };
  const maxUsdPerDay = nonNegFloat(await engine.getConfig('autopilot.auto_drain.max_usd_per_day'), 2.0);
  return {
    enabled: (await engine.getConfig('autopilot.auto_drain.enabled')) !== 'false',
    threshold: posInt(await engine.getConfig('autopilot.auto_drain.threshold'), 25),
    windowSeconds: posInt(await engine.getConfig('autopilot.auto_drain.window_seconds'), 120),
    maxUsdPerDay,
    // Rounded to cents first so 0.3 / 0.3 is 1, not 0.9999… → 0.
    maxJobsToday: Math.max(0, Math.floor(Math.round(maxUsdPerDay * 100) / Math.round(AUTO_DRAIN_PER_RUN_USD * 100))),
    utcDay: now.toISOString().slice(0, 10),
  };
}

/**
 * Drain jobs created since 00:00 UTC (all origins: autopilot, continuation,
 * manual), excluding `exceptJobId` (a deferred continuation rechecking its
 * own slot). null on error — callers fail closed.
 */
export async function countDrainJobsToday(engine: BrainEngine, utcDay: string, exceptJobId = 0): Promise<number | null> {
  try {
    const rows = await engine.executeRaw<{ cnt: number }>(
      `SELECT count(*)::int AS cnt FROM minion_jobs WHERE name = 'extract-atoms-drain' AND created_at >= $1::timestamptz AND id <> $2`,
      [`${utcDay}T00:00:00Z`, exceptJobId],
    );
    return Number(rows[0]?.cnt ?? 0);
  } catch {
    return null;
  }
}

/**
 * Id of a runnable backlog drain for this source (excluding `exceptJobId`),
 * else null — a job that will actually do the work. Managed-atom retries
 * (`retryRequestId`) share the name but do not drain. Unscoped jobs are 'default'.
 */
export async function inFlightDrainId(engine: BrainEngine, sourceId: string, exceptJobId = 0): Promise<number | null> {
  const rows = await engine.executeRaw<{ id: number }>(
    `SELECT id FROM minion_jobs WHERE name = 'extract-atoms-drain' AND status = ANY($3::text[])
       AND COALESCE(data->>'sourceId', 'default') = $1 AND id <> $2
       AND NOT (data ? 'retryRequestId') ORDER BY id LIMIT 1`,
    [sourceId, exceptJobId, RUNNABLE],
  );
  return rows.length > 0 ? Number(rows[0].id) : null;
}

export async function drainInFlight(engine: BrainEngine, sourceId: string, exceptJobId = 0): Promise<boolean> {
  return (await inFlightDrainId(engine, sourceId, exceptJobId)) !== null;
}

export interface DrainBacklog { pages: number | null; transcripts: number | null }

/** Pages always; transcripts only for 'default' with a checkout (where discovery applies). */
export async function readDrainBacklog(
  engine: BrainEngine, sourceId: string, localPath: string | null, utcDay = new Date().toISOString().slice(0, 10),
): Promise<DrainBacklog> {
  const pages = await countExtractAtomsBacklog(engine, sourceId);
  const transcripts = sourceId === 'default' && localPath
    ? await pendingTranscriptsForDueCheck(engine, localPath, utcDay)
    : 0;
  return { pages, transcripts };
}

/** Durable snapshot of the default source's live transcript count, keyed by corpus fingerprint + UTC day. */
export const TRANSCRIPT_BACKLOG_KEY = 'autopilot.auto_drain.transcript_backlog';
interface TranscriptBacklogSnapshot { signature: string; pending: number; day: string }

/** Stat-only fingerprint of the configured corpus; 'none' when none is configured, null on error. */
export async function transcriptBacklogSignature(engine: BrainEngine, brainDir: string): Promise<string | null> {
  try {
    const dirs = await resolveTranscriptCorpusDirs(engine, 'default', { brainDir });
    return dirs ? transcriptCorpusSignature(dirs) : 'none';
  } catch {
    return null;
  }
}

/** Best-effort: a failed write only means the next due check reads the corpus again. */
export async function recordTranscriptBacklog(engine: BrainEngine, snap: TranscriptBacklogSnapshot): Promise<void> {
  try { await engine.setConfig(TRANSCRIPT_BACKLOG_KEY, JSON.stringify(snap)); } catch { /* next check recounts */ }
}

async function readTranscriptBacklog(engine: BrainEngine): Promise<TranscriptBacklogSnapshot | null> {
  try {
    const v = JSON.parse((await engine.getConfig(TRANSCRIPT_BACKLOG_KEY)) ?? 'null');
    return v && typeof v.signature === 'string' && typeof v.pending === 'number' && typeof v.day === 'string' ? v : null;
  } catch {
    return null;
  }
}

/**
 * Live transcript backlog for the due check without reading the corpus on a
 * healthy tick: an unchanged fingerprint with a same-day snapshot reuses the
 * snapshot's count. Otherwise count for real (quietly) and snapshot it.
 *
 * The fingerprint is stat-only (path, size, mtime), so a reused snapshot can
 * be stale in EITHER direction within its UTC day: liveness also depends on
 * DB state and config the fingerprint does not see (atoms written or deleted
 * by another path, tombstones, corpus filter settings). Over-reporting costs
 * one drain that recounts and re-snapshots; under-reporting delays a drain
 * until the corpus files change or the next UTC day forces a recount. Any
 * drain of the default source also re-snapshots its final count.
 */
export async function pendingTranscriptsForDueCheck(engine: BrainEngine, brainDir: string, utcDay: string): Promise<number | null> {
  const signature = await transcriptBacklogSignature(engine, brainDir);
  if (signature === 'none') return 0;
  const snap = signature ? await readTranscriptBacklog(engine) : null;
  if (snap && snap.signature === signature && snap.day === utcDay) return snap.pending;
  const pending = await countPendingTranscripts(engine, 'default', { brainDir, quiet: true });
  if (pending !== null && signature) await recordTranscriptBacklog(engine, { signature, pending, day: utcDay });
  return pending;
}

export function isDrainDue(backlog: DrainBacklog, threshold: number): boolean {
  return (backlog.pages ?? 0) > threshold || (backlog.transcripts ?? 0) > 0;
}

export type BudgetRefusal = 'auto_drain_disabled' | 'zero_budget' | 'budget_unknown' | 'daily_cap';

/**
 * The one spend verdict for initial dispatch AND continuation. Fails closed:
 * disabled, a ceiling below one run ($0.30), or an unknown count → no slots.
 */
export function budgetVerdict(policy: AutoDrainPolicy, jobsToday: number | null):
  { ok: true; slots: number } | { ok: false; reason: BudgetRefusal } {
  if (!policy.enabled) return { ok: false, reason: 'auto_drain_disabled' };
  if (policy.maxJobsToday === 0) return { ok: false, reason: 'zero_budget' };
  if (jobsToday === null) return { ok: false, reason: 'budget_unknown' };
  if (jobsToday >= policy.maxJobsToday) return { ok: false, reason: 'daily_cap' };
  return { ok: true, slots: policy.maxJobsToday - jobsToday };
}

export const autoDrainKey = (sourceId: string, utcDay: string) => `autopilot-extract-atoms-drain:${sourceId}:${utcDay}`;

export interface DueSource { id: string; localPath: string; backlog: DrainBacklog }

/**
 * Sources that are due and have not had a drain today or in flight — the
 * slots fairness reserves. `limit` stops early once the caller has enough.
 */
export async function sourcesAwaitingDrain(
  engine: BrainEngine,
  policy: AutoDrainPolicy,
  opts: { excludeSourceId?: string; limit?: number; onSkip?: (sourceId: string, reason: string) => void } = {},
): Promise<DueSource[]> {
  const due: DueSource[] = [];
  for (const src of await loadAllSources(engine)) {
    if (opts.limit !== undefined && due.length >= opts.limit) break;
    if (src.id === opts.excludeSourceId || !src.local_path) continue;
    const skip = sourceLocalPathSkipWarning(src.id, src.local_path, undefined, src.config);
    if (skip) { opts.onSkip?.(src.id, skip); continue; }
    // Cheap SQL gates first; the backlog count (may read the transcript corpus) last.
    const dispatched = await engine.executeRaw('SELECT 1 FROM minion_jobs WHERE idempotency_key = $1 LIMIT 1',
      [autoDrainKey(src.id, policy.utcDay)]);
    if (dispatched.length > 0 || await drainInFlight(engine, src.id)) continue;
    // The tick's own day: the snapshot is keyed on the same day as the dispatch key.
    const backlog = await readDrainBacklog(engine, src.id, src.local_path, policy.utcDay);
    if (isDrainDue(backlog, policy.threshold)) due.push({ id: src.id, localPath: src.local_path, backlog });
  }
  return due;
}

/** Cheap in-lock recheck of a precomputed due set: drop sources dispatched or started since the scan. */
export async function recheckAwaiting(engine: BrainEngine, policy: AutoDrainPolicy, due: DueSource[]): Promise<DueSource[]> {
  const out: DueSource[] = [];
  for (const src of due) {
    const dispatched = await engine.executeRaw('SELECT 1 FROM minion_jobs WHERE idempotency_key = $1 LIMIT 1',
      [autoDrainKey(src.id, policy.utcDay)]);
    if (dispatched.length === 0 && !(await drainInFlight(engine, src.id))) out.push(src);
  }
  return out;
}

export type ContinuationGate<T> =
  | { ok: true; value: T; jobs_today: number }
  | { ok: false; reason: BudgetRefusal | 'reserved_for_other_sources'; jobs_today: number | null; reserved_for_other_sources?: string[] };

/**
 * Budget + fairness gate for a drain continuation, used at submit time and
 * again when a deferred continuation starts (`exceptJobId` = itself). Runs
 * `onAllowed` inside the cap lock. null = lock busy (caller must stay retryable).
 */
export async function continuationBudgetGate<T>(
  engine: BrainEngine,
  policy: AutoDrainPolicy,
  sourceId: string,
  exceptJobId: number,
  onAllowed: (jobsToday: number) => Promise<T>,
): Promise<{ value: ContinuationGate<T> } | null> {
  const pre = budgetVerdict(policy, 0);
  if (!pre.ok) return { value: { ok: false, reason: pre.reason, jobs_today: null } };
  // Expensive scan outside the lock; rechecked cheaply inside it.
  const others = await sourcesAwaitingDrain(engine, policy, { excludeSourceId: sourceId, limit: policy.maxJobsToday });
  return withDrainCapLock(engine, async (): Promise<ContinuationGate<T>> => {
    const today = await countDrainJobsToday(engine, policy.utcDay, exceptJobId);
    const verdict = budgetVerdict(policy, today);
    if (!verdict.ok) return { ok: false, reason: verdict.reason, jobs_today: today };
    const fresh = await recheckAwaiting(engine, policy, others);
    // Fairness: never take a slot another due source needs for its first drain today.
    if (today! + fresh.length >= policy.maxJobsToday) {
      return { ok: false, reason: 'reserved_for_other_sources', jobs_today: today, reserved_for_other_sources: fresh.map(o => o.id) };
    }
    return { ok: true, value: await onAllowed(today!), jobs_today: today! };
  });
}

/** Run `work` under the brain-wide cap lock; null when another submitter holds it past the retry budget. */
export async function withDrainCapLock<T>(engine: BrainEngine, work: () => Promise<T>): Promise<{ value: T } | null> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const handle = await tryAcquireDbLock(engine, CAP_LOCK_ID, 1);
    if (handle) {
      try { return { value: await work() }; } finally { await handle.release(); }
    }
    await new Promise<void>((r) => setTimeout(r, 50));
  }
  return null;
}

/**
 * Autopilot's initial dispatch: one drain per due source per UTC day, source
 * order, stopping at the daily cap. `blocked` says why nothing could be
 * dispatched (fail closed); a busy lock leaves no day key behind, so the next
 * tick simply tries again.
 */
export async function dispatchAutoDrains(
  engine: BrainEngine,
  queue: MinionQueue,
  opts: { timeoutMs?: number; onSkip?: (sourceId: string, reason: string) => void; onError?: (sourceId: string, e: unknown) => void },
): Promise<{ dispatched: Array<{ jobId: number; sourceId: string; backlog: DrainBacklog }>; blocked: BudgetRefusal | 'cap_lock_busy' | null }> {
  const policy = await readAutoDrainPolicy(engine);
  const pre = budgetVerdict(policy, 0);
  if (!pre.ok) return { dispatched: [], blocked: pre.reason };
  // Expensive scan outside the lock; rechecked cheaply inside it.
  const due = await sourcesAwaitingDrain(engine, policy, { limit: policy.maxJobsToday, onSkip: opts.onSkip });
  if (due.length === 0) return { dispatched: [], blocked: null };
  const gated = await withDrainCapLock(engine, async () => {
    const verdict = budgetVerdict(policy, await countDrainJobsToday(engine, policy.utcDay));
    if (!verdict.ok) return { dispatched: [], blocked: verdict.reason };
    const out: Array<{ jobId: number; sourceId: string; backlog: DrainBacklog }> = [];
    for (const src of (await recheckAwaiting(engine, policy, due)).slice(0, verdict.slots)) {
      // DO NOT use maxWaiting: it coalesces by (name, queue), not source. The
      // per-source day key plus the recheck above is the dedup. A failed
      // submit for one source never blocks the others.
      let job;
      try {
        job = await queue.add(
          'extract-atoms-drain',
          { sourceId: src.id, window: policy.windowSeconds, repoPath: src.localPath },
          {
            queue: 'default',
            idempotency_key: autoDrainKey(src.id, policy.utcDay),
            max_attempts: 3, // the handler throws on an all-provider-failed batch (#3218)
            ...(opts.timeoutMs ? { timeout_ms: opts.timeoutMs } : {}),
          },
          { allowProtectedSubmit: true },
        );
      } catch (e) { opts.onError?.(src.id, e); continue; }
      out.push({ jobId: job.id, sourceId: src.id, backlog: src.backlog });
    }
    return { dispatched: out, blocked: null };
  });
  return gated?.value ?? { dispatched: [], blocked: 'cap_lock_busy' };
}
