/**
 * v0.31 Hot Memory — bounded in-memory queue for fact extraction.
 *
 * Per /plan-eng-review D6 + D7:
 *   - Cap 100 entries; drop oldest on overflow with a counter increment.
 *   - Per-session in-flight=1 — serializes extraction within a session so
 *     burst chat doesn't fan out 50 parallel Haiku calls.
 *   - AbortSignal threading from server SIGTERM. On shutdown:
 *       1. Stop accepting new entries
 *       2. Best-effort 5s grace for in-flight extractions
 *       3. Drop pending with counter increment
 *
 * The queue is a singleton per process. `getFactsQueue()` lazy-initializes
 * with sensible defaults; tests inject a fresh instance via `__resetFactsQueue`.
 *
 * The queue takes opaque jobs `(handler, sessionId)` so callers compose the
 * actual extraction pipeline themselves. The queue's only job is order +
 * concurrency + dropping under load.
 */

import { registerBackgroundWorkDrainer } from '../background-work.ts';

export interface FactsQueueCounters {
  enqueued: number;
  completed: number;
  dropped_overflow: number;
  dropped_shutdown: number;
  failed: number;
}

export interface FactsQueueOpts {
  /** Max pending jobs in the queue. Defaults to 100. */
  cap?: number;
  /** Per-session in-flight cap. Defaults to 1 (serialized). */
  perSessionInflightCap?: number;
  /** Grace ms for in-flight to drain on shutdown. Defaults to 5000. */
  shutdownGraceMs?: number;
  /** External shutdown signal. When aborted, queue drains + drops pending. */
  abortSignal?: AbortSignal;
}

/** Job body — caller decides what runs. Must be cooperatively cancellable. */
export type FactsJob = (signal: AbortSignal) => Promise<void>;

interface QueueEntry {
  job: FactsJob;
  sessionId: string;
  enqueuedAt: number;
}

export class FactsQueue {
  private readonly cap: number;
  private readonly perSessionInflightCap: number;
  private readonly shutdownGraceMs: number;
  private readonly externalAbort?: AbortSignal;
  private readonly internalAbort = new AbortController();

  private pending: QueueEntry[] = [];
  /** Per-session in-flight count. */
  private inflightBySession = new Map<string, number>();
  /** Global in-flight count (for shutdown drain accounting). */
  private inflightTotal = 0;

  private counters: FactsQueueCounters = {
    enqueued: 0,
    completed: 0,
    dropped_overflow: 0,
    dropped_shutdown: 0,
    failed: 0,
  };

  private shuttingDown = false;
  private shutdownPromise: Promise<void> | null = null;

  constructor(opts: FactsQueueOpts = {}) {
    this.cap = Math.max(1, opts.cap ?? 100);
    this.perSessionInflightCap = Math.max(1, opts.perSessionInflightCap ?? 1);
    this.shutdownGraceMs = Math.max(0, opts.shutdownGraceMs ?? 5000);
    this.externalAbort = opts.abortSignal;
    if (this.externalAbort) {
      const onAbort = () => { void this.shutdown(); };
      if (this.externalAbort.aborted) onAbort();
      else this.externalAbort.addEventListener('abort', onAbort, { once: true });
    }
  }

  /**
   * Enqueue a job. Returns the queue depth after insertion (or -1 if dropped
   * because the queue is shutting down). Drop-oldest-on-overflow if cap hit.
   */
  enqueue(job: FactsJob, sessionId: string): number {
    if (this.shuttingDown) {
      this.counters.dropped_shutdown += 1;
      return -1;
    }
    if (this.pending.length >= this.cap) {
      // Drop oldest. Note: the dropped job's handler is never invoked; callers
      // upstream of the queue should treat enqueue() as fire-and-forget +
      // monitor counters for capacity pressure.
      this.pending.shift();
      this.counters.dropped_overflow += 1;
    }
    this.pending.push({ job, sessionId, enqueuedAt: Date.now() });
    this.counters.enqueued += 1;
    // Non-blocking pump: schedule on microtask so callers stay sync.
    queueMicrotask(() => { void this.pump(); });
    return this.pending.length;
  }

  /** Snapshot of the counters. */
  getCounters(): FactsQueueCounters {
    return { ...this.counters };
  }

  /** Pending depth (queued but not yet picked up). */
  pendingCount(): number {
    return this.pending.length;
  }

  /** In-flight count across all sessions. */
  inflightCount(): number {
    return this.inflightTotal;
  }

  /**
   * v0.41.25.0 (#1570) — wait for currently pending + in-flight jobs to
   * settle naturally. **Semantically distinct from `shutdown()`** — drain
   * does NOT abort in-flight work, does NOT drop pending, and does NOT
   * disable future enqueues. It just blocks until the queue reaches
   * (pending=0 AND inflight=0) OR the timeout fires.
   *
   * Per codex finding 9 from /codex review of the v0.41.25 plan: the
   * original "reuse shutdown" idea was wrong because shutdown aborts
   * in-flight (`this.internalAbort.abort()`), which means the very
   * facts:absorb worker that's trying to log its post-completion
   * absorb event gets aborted mid-write. That preserves the bug class
   * we're trying to fix.
   *
   * Per codex finding 10: this is bounded by `opts.timeout` (default
   * 1000ms) so commands that don't enqueue facts pay only one fast
   * 0ms check before exit. Capture / import / sync that DO enqueue
   * pay up to 1s while in-flight Haiku calls finish.
   *
   * Returns `{drained, unfinished}` so callers can log the outcome
   * for debugging (no stderr writes; that's the caller's choice).
   * `unfinished > 0` means timeout fired with work still pending —
   * those jobs aren't aborted, they just continue running while the
   * caller proceeds to exit (the singleton-still-alive contract in
   * the post-pivot architecture means they'll still be able to write
   * their logs).
   */
  async drainPending(
    opts: { timeout?: number } = {},
  ): Promise<{ drained: number; unfinished: number }> {
    const timeout = opts.timeout ?? 1000;
    const initiallyPending = this.pending.length;
    const initiallyInflight = this.inflightTotal;
    if (initiallyPending === 0 && initiallyInflight === 0) {
      return { drained: 0, unfinished: 0 };
    }
    const start = Date.now();
    while (
      (this.pending.length > 0 || this.inflightTotal > 0) &&
      Date.now() - start < timeout
    ) {
      // 25ms poll interval matches shutdown() below; consistent rhythm.
      await sleep(25);
    }
    const unfinished = this.pending.length + this.inflightTotal;
    const drained = initiallyPending + initiallyInflight - unfinished;
    return { drained, unfinished };
  }

  /**
   * Begin shutdown. Returns a promise that resolves once the queue has either
   * fully drained in-flight (under shutdownGraceMs) OR the grace expired. After
   * this resolves, all pending jobs are dropped with `dropped_shutdown` count.
   */
  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shuttingDown = true;
    this.internalAbort.abort();
    this.shutdownPromise = (async () => {
      const start = Date.now();
      while (this.inflightTotal > 0 && Date.now() - start < this.shutdownGraceMs) {
        await sleep(25);
      }
      // Drop everything still pending.
      const dropped = this.pending.length;
      this.pending = [];
      this.counters.dropped_shutdown += dropped;
    })();
    return this.shutdownPromise;
  }

  /** Pump: pick up entries respecting per-session in-flight cap. */
  private async pump(): Promise<void> {
    if (this.shuttingDown) return;
    // Find the next entry whose session has capacity.
    for (let i = 0; i < this.pending.length; i++) {
      const entry = this.pending[i];
      const inflight = this.inflightBySession.get(entry.sessionId) ?? 0;
      if (inflight < this.perSessionInflightCap) {
        // Claim it.
        this.pending.splice(i, 1);
        this.inflightBySession.set(entry.sessionId, inflight + 1);
        this.inflightTotal += 1;
        void this.runEntry(entry);
        // Try the next entry too — might have multiple sessions ready.
        return this.pump();
      }
    }
  }

  private async runEntry(entry: QueueEntry): Promise<void> {
    try {
      await entry.job(this.internalAbort.signal);
      this.counters.completed += 1;
    } catch (err) {
      // Don't propagate; caller sees nothing — the queue surface is fire-and-
      // forget by design. Counters expose visibility for `gbrain doctor`.
      const wasAbort = err instanceof Error && (err.name === 'AbortError' || /aborted/i.test(err.message));
      if (!wasAbort) {
        this.counters.failed += 1;
        // eslint-disable-next-line no-console
        console.warn(`[facts-queue] job failed for session=${entry.sessionId}: ${err instanceof Error ? err.message : String(err)}`);
      } else {
        this.counters.dropped_shutdown += 1;
      }
    } finally {
      const remaining = (this.inflightBySession.get(entry.sessionId) ?? 1) - 1;
      if (remaining <= 0) this.inflightBySession.delete(entry.sessionId);
      else this.inflightBySession.set(entry.sessionId, remaining);
      this.inflightTotal -= 1;
      // Pump in case the released slot unblocks another entry.
      queueMicrotask(() => { void this.pump(); });
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ── Process-singleton ──────────────────────────────────────

let _singleton: FactsQueue | null = null;

export function getFactsQueue(opts?: FactsQueueOpts): FactsQueue {
  if (!_singleton) _singleton = new FactsQueue(opts);
  return _singleton;
}

/** Test helper: reset the process-level singleton. */
export function __resetFactsQueueForTests(): void {
  _singleton = null;
}

// v0.42.20.0 — register as a background-work sink (order 0 — drained FIRST so
// its abort-path DB logIngest gets the freshest live-engine window). `abort` =
// shutdown(): sets shuttingDown=true (pump short-circuits) + fires internalAbort
// (the facts:absorb job forwards it to gateway.chat, cancelling a hung Haiku the
// drain-only fix can't). Registry AWAITS the abort so logIngest settles against
// a live engine before disconnect (#1762). `drainPending` itself stays
// non-aborting — the abort is the registry's separate post-drain step.
registerBackgroundWorkDrainer({
  name: 'facts',
  order: 0,
  drain: (ms) => getFactsQueue().drainPending({ timeout: ms }).then((r) => ({ unfinished: r.unfinished })),
  abort: () => getFactsQueue().shutdown(),
});
