/**
 * Idle upkeep (GBRA-438 PR 2): the resident runner. A `gbrain serve` runs
 * free upkeep while its agent is quiet, a few seconds at a time, so a keyless
 * repo-less brain is maintained without any installed service.
 *
 * The stdio serve calls `runIdleUpkeep` from its existing idle tick, after
 * the maintenance sweep and never beside it. The HTTP serve has no stdin, so
 * `armIdleUpkeep` gives it the same tick keyed on request activity (the
 * foreground-activity window its /mcp requests mark). Both skip the first
 * tick (never at boot), run only when upkeep is on and due, pass a small
 * budget, and abort the run when a request arrives.
 */
import type { BrainEngine } from '../engine.ts';
import { foregroundWindow, onForegroundRequest } from '../foreground-activity.ts';
import { readUpkeepRecord, runUnattendedMaintenance, upkeepDue, upkeepEnabled, type UpkeepOpts, type UpkeepOutcome } from './run.ts';

/** Wall-clock budget of one idle run; an unfinished round resumes on the next quiet tick. */
export const IDLE_UPKEEP_BUDGET_MS = 3_000;

export interface IdleUpkeepOpts {
  runner: string;
  signal: AbortSignal;
  budgetMs?: number;
  /** The process's first idle run: parked items get one more set of slices (UpkeepOpts.retryParked). */
  retryParked?: boolean;
  log?: (line: string) => void;
  /** Test seams, passed to the runner. */
  now?: () => Date;
  providers?: UpkeepOpts['providers'];
  cycle?: UpkeepOpts['cycle'];
}

/** One idle run: nothing (null) when upkeep is off or not due, else the runner's outcome. Never throws. */
export async function runIdleUpkeep(engine: BrainEngine, opts: IdleUpkeepOpts): Promise<UpkeepOutcome | null> {
  try {
    if (opts.signal.aborted || !await upkeepEnabled(engine)) return null;
    const record = await readUpkeepRecord(engine);
    if (!upkeepDue(record, (opts.now ?? (() => new Date()))()) && !(opts.retryParked && record?.parked?.length)) return null;
  } catch {
    return null;
  }
  const startedAt = Date.now();
  opts.log?.(`[gbrain serve] idle upkeep: started`);
  const outcome = await runUnattendedMaintenance(engine, {
    runner: opts.runner, budgetMs: opts.budgetMs ?? IDLE_UPKEEP_BUDGET_MS, signal: opts.signal, ...(opts.retryParked ? { retryParked: true } : {}),
    ...(opts.now ? { now: opts.now } : {}), ...(opts.providers ? { providers: opts.providers } : {}), ...(opts.cycle ? { cycle: opts.cycle } : {}),
  });
  opts.log?.(`[gbrain serve] idle upkeep: finished in ${Date.now() - startedAt} ms (${outcome.status}${outcome.code ? ` ${outcome.code}` : ''})`);
  return outcome;
}

/** One idle upkeep run; `retryParked` is true on the process's first run. */
export type IdleUpkeep = (engine: BrainEngine, signal: AbortSignal, retryParked: boolean) => Promise<unknown>;

export interface IdleUpkeepTimerDeps {
  intervalMs: number;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
  /** One run with the abort signal a request trips; defaults to `runIdleUpkeep` as runner `serve`. */
  upkeep?: IdleUpkeep;
  log?: (line: string) => void;
}

/**
 * The HTTP serve's idle tick: each interval with no foreground request since
 * the previous one runs one upkeep run (never two at once); the first tick
 * only opens the window. A request that starts mid-run aborts it.
 */
export function armIdleUpkeep(engine: BrainEngine, deps: IdleUpkeepTimerDeps): { stop(): void } {
  const upkeep: IdleUpkeep = deps.upkeep ?? ((e, signal, retryParked) => runIdleUpkeep(e, { runner: 'serve', signal, retryParked, log: deps.log }));
  const sawForeground = foregroundWindow();
  let opened = false;
  let first = true;
  let running: AbortController | null = null;
  const unsubscribe = onForegroundRequest(() => running?.abort());
  const handle = deps.setInterval(() => {
    const active = sawForeground();
    if (!opened) { opened = true; return; }
    if (active || running) return;
    const controller = new AbortController();
    running = controller;
    const retryParked = first;
    first = false;
    Promise.resolve()
      .then(() => upkeep(engine, controller.signal, retryParked))
      .catch(() => { /* best-effort; never kill serve */ })
      .finally(() => { if (running === controller) running = null; });
  }, deps.intervalMs);
  (handle as { unref?: () => void } | null)?.unref?.();
  return {
    stop() {
      deps.clearInterval(handle);
      unsubscribe();
      running?.abort();
    },
  };
}
