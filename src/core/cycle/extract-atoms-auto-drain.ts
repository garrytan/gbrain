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
 *    transcript pool is not in the page count). Counting is free — discovery
 *    plus two SELECTs, no LLM.
 *  - Duplicates: a source with a drain already waiting/active/delayed/paused,
 *    or already dispatched today, is never dispatched again.
 *  - Races: count-then-submit runs under one DB lock, so autopilot and
 *    concurrent handlers cannot jointly overshoot the cap.
 */

import type { BrainEngine } from '../engine.ts';
import type { MinionQueue } from '../minions/queue.ts';
import { tryAcquireDbLock } from '../db-lock.ts';
import { loadAllSources, sourceLocalPathSkipWarning } from '../sources-load.ts';
import { countExtractAtomsBacklog, countPendingTranscripts } from './extract-atoms.ts';

/** Each drain run is BudgetTracker-capped at ~$0.30; the cap counts jobs, not a spend ledger. */
export const AUTO_DRAIN_PER_RUN_USD = 0.3;
const CAP_LOCK_ID = 'extract-atoms-drain-daily-cap';
const IN_FLIGHT = ['waiting', 'active', 'delayed', 'paused', 'waiting-children'];

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

/** Drain jobs created since 00:00 UTC (all origins: autopilot, continuation, manual). null on error. */
export async function countDrainJobsToday(engine: BrainEngine, utcDay: string): Promise<number | null> {
  try {
    const rows = await engine.executeRaw<{ cnt: number }>(
      `SELECT count(*)::int AS cnt FROM minion_jobs WHERE name = 'extract-atoms-drain' AND created_at >= $1::timestamptz`,
      [`${utcDay}T00:00:00Z`],
    );
    return Number(rows[0]?.cnt ?? 0);
  } catch {
    return null;
  }
}

/** A drain for this source is queued or running (excluding `exceptJobId`). Unscoped jobs are 'default'. */
export async function drainInFlight(engine: BrainEngine, sourceId: string, exceptJobId = 0): Promise<boolean> {
  const rows = await engine.executeRaw(
    `SELECT 1 FROM minion_jobs WHERE name = 'extract-atoms-drain' AND status = ANY($3::text[])
       AND COALESCE(data->>'sourceId', 'default') = $1 AND id <> $2 LIMIT 1`,
    [sourceId, exceptJobId, IN_FLIGHT],
  );
  return rows.length > 0;
}

export interface DrainBacklog { pages: number | null; transcripts: number | null }

/** Pages always; transcripts only for 'default' with a checkout (where discovery applies). */
export async function readDrainBacklog(engine: BrainEngine, sourceId: string, localPath: string | null): Promise<DrainBacklog> {
  const pages = await countExtractAtomsBacklog(engine, sourceId);
  const transcripts = sourceId === 'default' && localPath
    ? await countPendingTranscripts(engine, sourceId, { brainDir: localPath })
    : 0;
  return { pages, transcripts };
}

export function isDrainDue(backlog: DrainBacklog, threshold: number): boolean {
  return (backlog.pages ?? 0) > threshold || (backlog.transcripts ?? 0) > 0;
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
    const backlog = await readDrainBacklog(engine, src.id, src.local_path);
    if (isDrainDue(backlog, policy.threshold)) due.push({ id: src.id, localPath: src.local_path, backlog });
  }
  return due;
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
 * Autopilot's initial dispatch: one drain per due source per UTC day, oldest
 * source order, stopping at the daily cap. Returns the dispatched jobs.
 */
export async function dispatchAutoDrains(
  engine: BrainEngine,
  queue: MinionQueue,
  opts: { timeoutMs?: number; onSkip?: (sourceId: string, reason: string) => void; onError?: (sourceId: string, e: unknown) => void },
): Promise<Array<{ jobId: number; sourceId: string; backlog: DrainBacklog }>> {
  const policy = await readAutoDrainPolicy(engine);
  if (!policy.enabled) return [];
  const gated = await withDrainCapLock(engine, async () => {
    const today = await countDrainJobsToday(engine, policy.utcDay);
    // count is best-effort for autopilot: an unknown count leaves one slot.
    const slots = Math.max(0, policy.maxJobsToday - (today ?? policy.maxJobsToday - 1));
    if (slots === 0) return [];
    const out: Array<{ jobId: number; sourceId: string; backlog: DrainBacklog }> = [];
    for (const src of await sourcesAwaitingDrain(engine, policy, { limit: slots, onSkip: opts.onSkip })) {
      // DO NOT use maxWaiting: it coalesces by (name, queue), not source. The
      // per-source day key plus the pre-check above is the dedup. A failed
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
    return out;
  });
  return gated?.value ?? [];
}
