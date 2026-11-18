/**
 * GST-3107: one `gbrain sources refresh` run's phase times, how long it held the worktree's refresh lock, and the
 * stale-link backlog shares its member syncs left. Inside a run, a member sync's tail derives links only for the pages it
 * imported (`runSyncTail` with `deferBacklog`), so the refresh lock is not held while the backlog drains; the run spends
 * each share after every refresh lock is released, one drain per source at a time.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { persistenceHome } from './identity.ts';
import { tryAcquireNativeLock } from './native-lock.ts';
import type { TailBacklogShare } from './sync-tail.ts';

export interface RefreshRun { phases: Record<string, number>; lockHeldMs?: number; backlog: Array<{ sourceId: string; share: TailBacklogShare }> }
/** `drained`: the backlog share ran (`pages` derived); `skipped`: another drain of the source was running; `failed`: it threw (`message`). */
export interface RefreshLinkBacklog { source_id: string; outcome: 'drained' | 'skipped' | 'failed'; pages: number; remaining?: number; message?: string }

export function notePhase(run: RefreshRun | undefined, key: string, ms: number): void {
  if (run) run.phases[key] = (run.phases[key] ?? 0) + ms;
}
export async function timedPhase<T>(run: RefreshRun | undefined, key: string, fn: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try { return await fn(); } finally { notePhase(run, key, performance.now() - started); }
}
export function noteLockHeld(run: RefreshRun | undefined, started: number): void {
  if (run) run.lockHeldMs = (run.lockHeldMs ?? 0) + performance.now() - started;
}

/**
 * Spends the run's backlog shares (after every refresh lock is released) and returns the result fields the run reports.
 * A source whose drain lock another process holds is skipped and named; a failure is reported on the share's entry and
 * never fails the refresh, whose imports already completed. `beforeDrain` is the test seam `hooks.backlog`.
 */
export async function finishRefreshRun(engine: BrainEngine, run: RefreshRun, opts: { beforeDrain?: (sourceId: string) => Promise<void> | void; redact: (text: string) => string }):
  Promise<{ phase_ms?: Record<string, number>; lock_held_ms?: number; link_backlog?: RefreshLinkBacklog[] }> {
  const drained: RefreshLinkBacklog[] = [];
  if (run.backlog.length) {
    const { drainSyncTailBacklog } = await import('./sync-tail.ts');
    const started = performance.now();
    for (const { sourceId, share } of run.backlog) {
      try {
        const lock = await tryAcquireNativeLock(join(persistenceHome(), 'locks', `link-backlog-${createHash('sha256').update(sourceId).digest('hex').slice(0, 32)}.lock`));
        if (!lock) { drained.push({ source_id: sourceId, outcome: 'skipped', pages: 0 }); continue; }
        try {
          await opts.beforeDrain?.(sourceId);
          const links = await drainSyncTailBacklog(engine, sourceId, share);
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
