/**
 * The one in-process scheduler for the automatic facts drain (drain.ts), used
 * by stdio `gbrain serve` and `gbrain serve --http`. Its own unref'd timer
 * (never the 3-second idle maintenance sweep) ticks every 10 minutes; a tick
 * runs one bounded drain when the owner saw no foreground activity since the
 * previous tick, or when 30 minutes passed since the last run, so sustained
 * MCP traffic still gets a run at least every 30 minutes. At most one run is
 * in flight; `stop()` aborts it (the signal reaches the job handler) and
 * waits a bounded time for it to settle. A tick the owner vetoes (`canRun`,
 * e.g. while a delegated sync owns the event loop) is skipped, so the
 * 30-minute bound excludes an uninterrupted delegated sync.
 */
import type { BrainEngine } from '../engine.ts';
import { runFactsDrain, type FactsDrainOwner, type FactsDrainRunResult } from './drain.ts';

export const FACTS_DRAIN_TICK_MS = 10 * 60_000;
export const FACTS_DRAIN_MAX_GAP_MS = 30 * 60_000;
const STOP_SETTLE_MS = 5_000;

export interface FactsDrainSchedulerOpts {
  owner: FactsDrainOwner;
  tickMs?: number;
  maxGapMs?: number;
  wallClockMs?: number;
  /** Epoch ms of the owner's last foreground activity; omitted = always quiet. */
  lastActivityAt?: () => number;
  /** Owner veto for this tick (delegated sync running, engine degraded, shutting down). */
  canRun?: () => boolean | Promise<boolean>;
  setInterval?: (fn: () => unknown, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  now?: () => number;
  log?: (line: string) => void;
  /** Test seam: replaces runFactsDrain. */
  run?: (engine: BrainEngine, opts: { owner: FactsDrainOwner; signal: AbortSignal; wallClockMs?: number; log?: (line: string) => void }) => Promise<FactsDrainRunResult>;
}

export interface FactsDrainScheduler {
  /** Run one tick's decision now (tests and owners that want an early check). */
  tick(): Promise<FactsDrainRunResult | null>;
  stop(): Promise<void>;
  readonly running: boolean;
}

export function startFactsDrainScheduler(engine: BrainEngine, opts: FactsDrainSchedulerOpts): FactsDrainScheduler {
  const tickMs = opts.tickMs ?? FACTS_DRAIN_TICK_MS;
  const maxGapMs = opts.maxGapMs ?? FACTS_DRAIN_MAX_GAP_MS;
  const now = opts.now ?? Date.now;
  const run = opts.run ?? runFactsDrain;
  const abort = new AbortController();
  let lastRunAt = now();
  let lastTickAt = now();
  let inflight: Promise<FactsDrainRunResult | null> | null = null;
  let stopped = false;

  const tick = async (): Promise<FactsDrainRunResult | null> => {
    if (stopped || inflight || engine.kind !== 'pglite') return null;
    const at = now();
    const previousTick = lastTickAt;
    lastTickAt = at;
    const quiet = (opts.lastActivityAt?.() ?? 0) < previousTick;
    if (!quiet && at - lastRunAt < maxGapMs) return null;
    try {
      if (opts.canRun && !(await opts.canRun())) return null;
    } catch {
      return null;
    }
    lastRunAt = at;
    inflight = run(engine, { owner: opts.owner, signal: abort.signal, wallClockMs: opts.wallClockMs, ...(opts.log ? { log: opts.log } : {}) })
      .catch(() => null)
      .finally(() => { inflight = null; });
    return inflight;
  };

  const set = opts.setInterval ?? ((fn: () => unknown, ms: number) => setInterval(fn, ms));
  const clear = opts.clearInterval ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>));
  const handle = engine.kind === 'pglite' ? set(() => tick(), tickMs) : null;
  (handle as { unref?: () => void } | null)?.unref?.();

  return {
    tick,
    get running() { return inflight !== null; },
    async stop() {
      if (stopped) return;
      stopped = true;
      if (handle !== null) clear(handle);
      abort.abort(new Error('shutdown'));
      const current = inflight;
      if (!current) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([current, new Promise(resolve => { timer = setTimeout(resolve, STOP_SETTLE_MS); timer.unref?.(); })]);
      clearTimeout(timer);
    },
  };
}
