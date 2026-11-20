/**
 * GST-3107: one `gbrain sources refresh` run's phase times, how long it held the worktree's refresh lock, and the
 * stale-link backlog shares its member syncs left. Inside a run, a member sync's tail derives links only for the pages it
 * imported (`runSyncTail` with `deferBacklog`), so the refresh lock is not held while the backlog drains; the run spends
 * each share after every refresh lock is released, one refresh's drain per source of a brain at a time.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { persistenceHome } from './identity.ts';
import { tryAcquireNativeLock } from './native-lock.ts';
import type { NativeLockHandle } from './native-lock.ts';
import type { TailBacklogShare } from './sync-tail.ts';

export interface RefreshRun { phases: Record<string, number>; lockHeldMs?: number; backlog: Array<{ sourceId: string; share: TailBacklogShare }> }
/** The run's fields of `WorktreeRefreshResult`, which only the CLI's `--json` prints. */
export interface RefreshRunReport {
  /** Whole milliseconds per phase this run reached (`fetch`, `precheck`, `drain`, `merge`, `sync`, `tail`, `backlog`). */
  phase_ms?: Record<string, number>;
  /** How long this run held the worktree's refresh lock, in whole milliseconds; absent when it never took it. */
  lock_held_ms?: number;
  /** The stale-link backlog each member's sync left, drained after the refresh lock was released. */
  link_backlog?: RefreshLinkBacklog[];
}
/** `drained`: the backlog share ran (`pages` derived); `skipped`: another drain of the source was running; `failed`: it threw (`message`). */
export interface RefreshLinkBacklog { source_id: string; outcome: 'drained' | 'skipped' | 'failed'; pages: number; remaining?: number; message?: string }

export function notePhase(run: RefreshRun | undefined, key: string, ms: number): void {
  if (run) run.phases[key] = (run.phases[key] ?? 0) + ms;
}
export async function timedPhase<T>(run: RefreshRun | undefined, key: string, fn: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try { return await fn(); } finally { notePhase(run, key, performance.now() - started); }
}
/** Adds the time `lock` stays held, from now until its release, to the run's `lock_held_ms`. */
export function timedLock(run: RefreshRun | undefined, lock: NativeLockHandle | null): NativeLockHandle | null {
  if (!run || !lock) return lock;
  const started = performance.now();
  return { get released() { return lock.released; }, release: async () => {
    if (!lock.released) run.lockHeldMs = (run.lockHeldMs ?? 0) + performance.now() - started;
    await lock.release();
  } };
}
/** Keeps the stale-link backlog share a member sync's deferred tail left, for the run to spend after its locks are released. */
export function noteBacklog<T extends { tail?: { backlog?: TailBacklogShare } }>(run: RefreshRun | undefined, sourceId: string, result: T): T {
  if (run && result.tail?.backlog) run.backlog.push({ sourceId, share: result.tail.backlog });
  return result;
}

type FinishOptions = { beforeDrain?: (sourceId: string) => Promise<void> | void; redact: (text: string) => string };

/** Runs one refresh with a fresh run record, then spends its backlog shares, on success and failure alike, and adds the run's fields to the result. */
export async function withRefreshRun<T extends object>(engine: BrainEngine, opts: FinishOptions, refresh: (run: RefreshRun) => Promise<T>): Promise<T & RefreshRunReport> {
  const run: RefreshRun = { phases: {}, backlog: [] };
  let result: T;
  try { result = await refresh(run); }
  catch (error) { await finishRefreshRun(engine, run, opts).catch(() => undefined); throw error; }
  return { ...result, ...await finishRefreshRun(engine, run, opts) };
}

/**
 * Spends the run's backlog shares (after every refresh lock is released) and returns the result fields the run reports.
 * A source whose drain lock another process of the same brain holds is skipped and named (the lock is keyed by brain id
 * and source id, since every brain has a `default` source and brains can share one GBRAIN_HOME); a failure is reported on the share's entry and
 * never fails the refresh, whose imports already completed. The drains share the latest member tail's deadline, so they
 * end when the in-lock tails would have. `beforeDrain` is the test seam `hooks.backlog`.
 */
async function finishRefreshRun(engine: BrainEngine, run: RefreshRun, opts: FinishOptions): Promise<RefreshRunReport> {
  const drained: RefreshLinkBacklog[] = [];
  if (run.backlog.length) {
    const { drainSyncTailBacklog } = await import('./sync-tail.ts');
    const started = performance.now(), deadlineAtMs = Math.max(...run.backlog.map(item => item.share.deadlineAtMs));
    let brain: Promise<string | null> | undefined;
    for (const { sourceId, share } of run.backlog) {
      try {
        const lock = await tryAcquireNativeLock(join(persistenceHome(), 'locks', `link-backlog-${createHash('sha256').update(`${await (brain ??= engine.readPersistenceBrainId())}\0${sourceId}`).digest('hex').slice(0, 32)}.lock`));
        if (!lock) { drained.push({ source_id: sourceId, outcome: 'skipped', pages: 0 }); continue; }
        try {
          await opts.beforeDrain?.(sourceId);
          const links = await drainSyncTailBacklog(engine, sourceId, { ...share, deadlineAtMs });
          drained.push({ source_id: sourceId, outcome: 'drained', pages: links.pages, remaining: links.remaining });
        } finally { await lock.release(); }
      } catch (error) {
        drained.push({ source_id: sourceId, outcome: 'failed', pages: 0, message: opts.redact(error instanceof Error ? error.message : String(error)) });
      }
    }
    notePhase(run, 'backlog', performance.now() - started);
  }
  const phases = Object.fromEntries(Object.entries(run.phases).map(([key, ms]) => [key, Math.round(ms)]));
  return { ...(Object.keys(phases).length ? { phase_ms: phases } : {}), ...(run.lockHeldMs !== undefined ? { lock_held_ms: Math.round(run.lockHeldMs) } : {}),
    ...(drained.length ? { link_backlog: drained } : {}) };
}
