/**
 * db-pacer.ts — composable DB-contention pacing primitive (paced-backfill internals).
 *
 * gbrain's bulk write paths (embed --stale, sync) can saturate a PgBouncer
 * transaction-mode pooler and starve the minion supervisor's lock renewals.
 * An operator's external SIGSTOP/SIGCONT wrapper proved the idea but was blind
 * (out-of-band probe pool), unsafe (froze the child mid-transaction), and
 * couldn't touch PEAK pressure (it paused between batches while N workers were
 * already in flight).
 *
 * This primitive fixes all three:
 *   - CONCURRENCY CAP is the real lever. `acquire()` is a counting semaphore
 *     that bounds simultaneous in-flight DB writes — directly limiting pooler
 *     slots held at once. (Single-pool callers like embed instead lower their
 *     worker count to `maxConcurrency`; the permit exists for the MULTI-pool
 *     case — sync's separate engine per worker — where one budget must span
 *     pools a single worker-count can't.)
 *   - IN-BAND latency is the signal. `observe(ms)` feeds an EWMA from the work's
 *     OWN queries — it can never be blind the way a separate probe pool was.
 *   - COOPERATIVE sleep, never SIGSTOP. `pace()` sleeps between safe points on
 *     `setTimeout` (timers phase), so the lock-heartbeat `setInterval` keeps
 *     firing. Per-call jitter prevents a 20-worker thundering-herd resume.
 *
 * Contracts:
 *   - `acquire()` / `pace()` THROW `AbortError` if the signal fires while
 *     waiting — a cancel can never fall through into a DB call.
 *   - FAIL-OPEN: any unexpected internal error degrades to a no-op; a pacer bug
 *     must never kill a backfill, and nothing here throws an unhandledRejection
 *     (the failure class behind the prior #1972 lock-renewal crash).
 *   - `off` mode / PGLite → `createNoopPacer()`: unbounded permits, zero sleeps.
 */

import { AbortError, anySignal } from './abort-check.ts';
import type { PaceBundle } from './pace-mode.ts';

/** Snapshot of pacer state for telemetry + tests. */
export interface PaceSnapshot {
  enabled: boolean;
  maxConcurrency: number;
  /** Permits currently held. */
  active: number;
  /** EWMA of observed DB-op latency (ms); null until the first sample. */
  ewmaMs: number | null;
  /** Cumulative ms spent in cooperative sleeps. */
  totalSleptMs: number;
  /** Number of `pace()` calls that actually slept. */
  sleepCount: number;
  /** High-water mark of waiters blocked in `acquire()`. */
  maxWaiters: number;
  /** Count of `observe()` samples folded into the EWMA. */
  sampleCount: number;
}

/** A held permit. `release()` is idempotent. */
export interface Permit {
  release(): void;
}

export interface DbPacer {
  /**
   * Acquire a DB-write permit (caps simultaneous in-flight writes to
   * `maxConcurrency`). THROWS `AbortError` if `signal` fires while waiting.
   * On a disabled pacer, resolves immediately with a no-op permit.
   */
  acquire(signal?: AbortSignal): Promise<Permit>;
  /** Feed an observed DB-op latency sample (ms). NaN / negative is ignored. */
  observe(latencyMs: number): void;
  /**
   * Cooperative sleep when recent latency is high (EWMA > `paceAtMs`), jittered
   * per call and capped at `maxSleepMs`. No-op when latency is fine. THROWS
   * `AbortError` if `signal` fires during the sleep.
   */
  pace(signal?: AbortSignal): Promise<void>;
  snapshot(): PaceSnapshot;
  /** Stop accepting waiters and release any blocked acquirers. Idempotent. */
  dispose(): void;
}

/** Test/impl seams. Production defaults read real timers + Math.random. */
export interface DbPacerSeams {
  /** Sleep `ms`, rejecting `AbortError` if `signal` fires first. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Jitter source in [0, 1). */
  rng?: () => number;
}

export interface CreateDbPacerOpts extends DbPacerSeams {
  bundle: PaceBundle;
}

interface Waiter {
  resolve: (p: Permit) => void;
  reject: (e: unknown) => void;
  onAbort?: () => void;
  cleanup?: () => void;
  signal?: AbortSignal;
}

/**
 * Default abortable sleep. Resolves after `ms`; rejects `AbortError` if the
 * signal fires first. `ms <= 0` resolves on the next microtask.
 */
function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new AbortError(abortReason(signal)));
  if (!(ms > 0)) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    // NOTE: do NOT unref() this timer. The bulk loop is awaiting it, so if it
    // were unref'd and no other referenced handle existed, the process could
    // exit mid-sleep and truncate the backfill (Codex P1).
    const onAbort = () => {
      cleanup();
      reject(new AbortError(abortReason(signal)));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function abortReason(signal?: AbortSignal | null): string {
  const r = signal?.reason;
  if (r instanceof Error) return r.message;
  return String(r ?? 'aborted');
}

const NOOP_PERMIT: Permit = { release() {} };

/** No-op pacer: unbounded concurrency, zero sleeps. For `off` mode / PGLite. */
export function createNoopPacer(): DbPacer {
  return {
    acquire: () => Promise.resolve(NOOP_PERMIT),
    observe: () => {},
    pace: () => Promise.resolve(),
    snapshot: () => ({
      enabled: false,
      maxConcurrency: 0,
      active: 0,
      ewmaMs: null,
      totalSleptMs: 0,
      sleepCount: 0,
      maxWaiters: 0,
      sampleCount: 0,
    }),
    dispose: () => {},
  };
}

export function createDbPacer(opts: CreateDbPacerOpts): DbPacer {
  const { bundle } = opts;
  if (!bundle.enabled) return createNoopPacer();

  const max = Math.max(1, Math.floor(bundle.maxConcurrency));
  const paceAtMs = Math.max(0, bundle.paceAtMs);
  const maxSleepMs = Math.max(0, bundle.maxSleepMs);
  const alpha = bundle.ewmaAlpha > 0 && bundle.ewmaAlpha <= 1 ? bundle.ewmaAlpha : 0.3;
  const sleep = opts.sleep ?? defaultSleep;
  const rng = opts.rng ?? Math.random;

  let active = 0;
  let disposed = false;
  let ewma: number | null = null;
  let totalSleptMs = 0;
  let sleepCount = 0;
  let maxWaiters = 0;
  let sampleCount = 0;
  const waiters: Waiter[] = [];

  function makePermit(): Permit {
    let released = false;
    return {
      release() {
        if (released) return;
        released = true;
        // Hand the slot to the next waiter without dropping `active`, so the
        // cap is never momentarily exceeded.
        const next = waiters.shift();
        if (next) {
          next.cleanup?.();
          next.resolve(makePermit());
        } else {
          active = Math.max(0, active - 1);
        }
      },
    };
  }

  async function acquire(signal?: AbortSignal): Promise<Permit> {
    try {
      if (signal?.aborted) throw new AbortError(abortReason(signal));
      if (disposed) return NOOP_PERMIT;
      if (active < max) {
        active++;
        return makePermit();
      }
      return await new Promise<Permit>((resolve, reject) => {
        const waiter: Waiter = { resolve, reject, signal };
        const onAbort = () => {
          const i = waiters.indexOf(waiter);
          if (i >= 0) waiters.splice(i, 1);
          reject(new AbortError(abortReason(signal)));
        };
        waiter.onAbort = onAbort;
        waiter.cleanup = () => signal?.removeEventListener('abort', onAbort);
        signal?.addEventListener('abort', onAbort, { once: true });
        waiters.push(waiter);
        if (waiters.length > maxWaiters) maxWaiters = waiters.length;
      });
    } catch (err) {
      // Abort must propagate so the loop can't fall into a DB call.
      if (err instanceof AbortError) throw err;
      // Anything else: fail-open (a pacer bug must not kill the backfill).
      return NOOP_PERMIT;
    }
  }

  function observe(latencyMs: number): void {
    try {
      if (typeof latencyMs !== 'number' || !Number.isFinite(latencyMs) || latencyMs < 0) return;
      ewma = ewma === null ? latencyMs : alpha * latencyMs + (1 - alpha) * ewma;
      sampleCount++;
    } catch {
      /* fail-open */
    }
  }

  async function pace(signal?: AbortSignal): Promise<void> {
    let ms = 0;
    try {
      if (ewma === null || ewma <= paceAtMs || maxSleepMs <= 0) return;
      const base = Math.min(maxSleepMs, ewma);
      // Jitter to 50-100% of base so N workers don't resume in lockstep.
      const jitter = 0.5 + 0.5 * clamp01(rng());
      ms = Math.round(base * jitter);
      if (ms <= 0) return;
    } catch {
      return; // fail-open: never let knob math kill the loop
    }
    try {
      await sleep(ms, signal);
      totalSleptMs += ms;
      sleepCount++;
    } catch (err) {
      // Abort must propagate (a cancel can't be swallowed); any other sleep
      // failure is fail-open — a pacer bug never kills the backfill.
      if (err instanceof AbortError) throw err;
    }
  }

  function snapshot(): PaceSnapshot {
    return {
      enabled: true,
      maxConcurrency: max,
      active,
      ewmaMs: ewma,
      totalSleptMs,
      sleepCount,
      maxWaiters,
      sampleCount,
    };
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    // Release blocked acquirers with no-op permits so their loops end cleanly
    // rather than hanging forever.
    while (waiters.length > 0) {
      const w = waiters.shift();
      w?.cleanup?.();
      w?.resolve(NOOP_PERMIT);
    }
  }

  return { acquire, observe, pace, snapshot, dispose };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * Convenience: time a DB op and feed its latency to the pacer. Keeps call sites
 * a one-liner — `await observed(pacer, () => engine.upsertChunks(...))`.
 */
export async function observed<T>(pacer: DbPacer, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  try {
    return await fn();
  } finally {
    pacer.observe(Date.now() - t0);
  }
}

// anySignal is re-exported intentionally so call sites that compose a budget
// signal with the pacer can import from one place.
export { anySignal };
