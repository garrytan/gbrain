/**
 * Sliding worker pool + bounded semaphore (v0.41.15.0).
 *
 * Single source of truth for bounded-concurrency work over a list of
 * items. Extracted from `src/commands/embed.ts` (the gold-standard
 * sliding pool, both `embedAll` simple path and `embedAllStale`
 * paginated+abort path) and `src/commands/eval-cross-modal.ts`
 * (`runWithLimit` semaphore).
 *
 * Two exports:
 *   - `runSlidingPool({items, workers, onItem, ...})` — N workers
 *     atomically claim items from a shared queue. Throughput beats
 *     fixed-window `Promise.all([Promise.all(batch), ...])` because
 *     fast workers don't wait for slow workers to finish a whole batch.
 *   - `runWithLimit({items, limit, fn})` — bounded `Promise.allSettled`
 *     shape. Returns a tagged result array so callers see per-item
 *     success/failure without throwing on the first error.
 *
 * ============================================================
 * ATOMICITY INVARIANT (load-bearing — pinned by CI guard at
 * scripts/check-worker-pool-atomicity.sh; wired into `bun run verify`)
 * ============================================================
 *
 * The sliding pool's correctness rests on `const idx = nextIdx++`
 * being atomic across the N concurrent `worker()` invocations.
 *
 * This is TRUE on Node.js / Bun because:
 *   1. JS single-threaded event loop: no two `worker()` invocations
 *      run statements concurrently on different threads.
 *   2. The claim is ONE synchronous statement — there is NO `await`
 *      between the read and the write. The scheduler cannot yield
 *      between `nextIdx` (read) and `nextIdx + 1` (write).
 *
 * Two failure modes would silently break the invariant:
 *   - `worker_threads` import in any file that uses `runSlidingPool`:
 *     pool work would cross kernel threads, no event-loop guarantee.
 *     Two workers could claim the same idx; duplicate work + duplicate
 *     DB writes. Same failure shape as D2's per-page lock exists to
 *     defend against, but the lock is a defense-in-depth safety net,
 *     NOT the primary correctness story.
 *   - `const idx = await getNextIdx()` style refactor: introduces an
 *     `await` in the claim line; another worker can run during the
 *     yield window between the function call and the assignment.
 *
 * The CI guard rejects both patterns. Do NOT remove it without
 * understanding what it guards.
 *
 * ============================================================
 * MUST-ABORT ERROR CLASSES (D13)
 * ============================================================
 *
 * Most onItem errors flow through `onError` (default: collect into
 * `failures[]` and continue). But some error classes MUST hard-abort
 * the pool regardless of onError policy:
 *   - BudgetExhausted: when one worker hits --max-cost-usd, every
 *     other worker must stop immediately, not race to spend more.
 *     Pre-D13, N workers each independently hit reserve() and burned
 *     N × per-call-cost over the cap.
 *
 * The helper checks `err.tag` against `MUST_ABORT_ERROR_TAGS` BEFORE
 * dispatching to onError. Matched errors: set aborted=true, call
 * AbortController.abort() (propagates to in-flight onItem via
 * `signal`), rethrow. This makes "cap is a hard ceiling" a structural
 * property of the helper, not a per-caller convention.
 *
 * Future tagged classes (UnrecoverableError, etc.) add their tag to
 * MUST_ABORT_ERROR_TAGS. Property-tag match avoids cross-module
 * import dependencies.
 *
 * ============================================================
 * FAILURE CAPTURE SHAPE (D7 + codex #10)
 * ============================================================
 *
 * `failures[]` stores `{ idx, label, error }`, NOT the full item.
 * Callers supply `failureLabel(item) => string` (default: `String(item)`)
 * so a 197K-page brain on a worst-case all-failure run doesn't carry
 * 197K Page objects in memory.
 */

/** Tagged error classes that bypass `onError` and hard-abort the pool. */
export const MUST_ABORT_ERROR_TAGS: ReadonlySet<string> = new Set([
  'BUDGET_EXHAUSTED', // src/core/budget/budget-tracker.ts BudgetExhausted.tag
]);

/**
 * Check if an error is a must-abort class. Uses property-tag match
 * (`err.tag === 'BUDGET_EXHAUSTED'`) to avoid cross-module import
 * dependencies. Tolerates any thrown value shape.
 */
export function isMustAbortError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const tag = (err as { tag?: unknown }).tag;
  return typeof tag === 'string' && MUST_ABORT_ERROR_TAGS.has(tag);
}

/** Per-item failure record stored in `SlidingPoolResult.failures`. */
export interface PoolFailure {
  /** Index in the original items array. */
  idx: number;
  /** Caller-provided label (defaults to `String(item)`). */
  label: string;
  /** The thrown error or value. */
  error: unknown;
}

export interface SlidingPoolOpts<T> {
  /** Pre-enumerated work list. Empty input is a no-op (returns immediately). */
  items: readonly T[];
  /** Worker count. Clamped to `[1, items.length]` internally. */
  workers: number;
  /**
   * Per-item work. Receives item + its position in `items` + the worker
   * slot index (0-based; useful for per-worker logging). Throwing flows
   * through `onError` unless the error is a must-abort class (see header).
   */
  onItem: (item: T, idx: number, workerIdx: number) => Promise<void>;
  /**
   * AbortSignal honored at TWO points:
   *   1. Before each claim — aborted workers exit cleanly without
   *      claiming new items.
   *   2. Passed-through implicitly: callers that want mid-item abort
   *      must thread the same signal INTO their `onItem`.
   */
  signal?: AbortSignal;
  /**
   * Fires after each successful item with running totals. Order is
   * non-deterministic (sliding pool semantics — fast workers report
   * sooner). Tests asserting event ORDER will be flaky; assert
   * INVARIANTS (count == processed, monotonic done counter).
   */
  onProgress?: (done: number, total: number) => void;
  /**
   * Per-error policy. Default: 'continue' (collect into failures[],
   * keep claiming). Pass 'abort' or a function returning 'abort' to
   * stop the pool on first error. MUST_ABORT_ERROR_TAGS always
   * bypass this and hard-abort regardless.
   *
   * Default 'continue' picked because every real bulk caller wants
   * tolerant semantics for I/O errors (one bad page shouldn't kill
   * a 6594-page backfill). Per D7.
   */
  onError?: 'continue' | 'abort' | ((err: unknown, item: T, idx: number) => 'continue' | 'abort');
  /**
   * Project a stable label from an item for failure records. Default
   * `String(item)`. Pass a projector like `p => p.slug` to keep
   * failures small in memory on large brains. Per codex #10.
   */
  failureLabel?: (item: T) => string;
}

export interface SlidingPoolResult {
  /** Number of items that completed successfully (onItem did not throw). */
  processed: number;
  /** Number of items whose onItem threw (also length of failures[]). */
  errored: number;
  /** True when the pool aborted before claiming all items. */
  aborted: boolean;
  /**
   * Per-failure records. Bounded shape (idx + label + error), NOT
   * full items, to keep memory bounded on large brains.
   */
  failures: PoolFailure[];
}

/**
 * Run N workers over `items`. Workers atomically claim the next item
 * from a shared queue index (see ATOMICITY INVARIANT in module header).
 * Returns when every item has been claimed AND every worker has
 * finished its current item, OR when aborted.
 *
 * Empty `items` returns immediately with zeroed result. Worker count
 * is clamped to `[1, items.length]` so we never spawn more workers
 * than work.
 */
export async function runSlidingPool<T>(opts: SlidingPoolOpts<T>): Promise<SlidingPoolResult> {
  const items = opts.items;
  const total = items.length;
  const result: SlidingPoolResult = {
    processed: 0,
    errored: 0,
    aborted: false,
    failures: [],
  };
  if (total === 0) return result;

  const workerCount = Math.max(1, Math.min(opts.workers, total));
  const labelFn = opts.failureLabel ?? ((x: T) => String(x));
  // Local AbortController composed with the caller's signal so a
  // must-abort error from one worker also signals every other worker's
  // in-flight onItem (if the onItem honors signals).
  const localAbort = new AbortController();
  const onCallerAbort = () => localAbort.abort();
  if (opts.signal) {
    if (opts.signal.aborted) localAbort.abort();
    else opts.signal.addEventListener('abort', onCallerAbort, { once: true });
  }

  // Resolve onError into a uniform function form.
  const errorPolicy = opts.onError ?? 'continue';
  const decideOnError = (err: unknown, item: T, idx: number): 'continue' | 'abort' => {
    if (typeof errorPolicy === 'function') return errorPolicy(err, item, idx);
    return errorPolicy;
  };

  // Sliding worker pool. See ATOMICITY INVARIANT in module header.
  // CI guard `scripts/check-worker-pool-atomicity.sh` rejects refactors
  // that put an `await` between the `nextIdx` read and write OR import
  // `worker_threads` alongside this module.
  let nextIdx = 0;

  async function worker(workerIdx: number): Promise<void> {
    while (true) {
      if (localAbort.signal.aborted) {
        result.aborted = true;
        return;
      }
      if (nextIdx >= total) return;
      // ATOMICITY INVARIANT: this line is the load-bearing claim.
      // Read + increment must remain a single synchronous statement.
      // Do NOT insert `await` between them. See module header.
      const idx = nextIdx++;
      const item = items[idx];
      try {
        await opts.onItem(item, idx, workerIdx);
        result.processed++;
        opts.onProgress?.(result.processed, total);
      } catch (err) {
        // D13: must-abort error classes (BudgetExhausted, etc.) bypass
        // onError and hard-abort the pool. Rethrowing propagates up
        // through Promise.all; the local abort signals other workers.
        if (isMustAbortError(err)) {
          result.aborted = true;
          result.errored++;
          result.failures.push({ idx, label: labelFn(item), error: err });
          localAbort.abort();
          throw err;
        }
        result.errored++;
        result.failures.push({ idx, label: labelFn(item), error: err });
        const decision = decideOnError(err, item, idx);
        if (decision === 'abort') {
          result.aborted = true;
          localAbort.abort();
          return;
        }
        // 'continue' — claim the next item.
      }
    }
  }

  try {
    await Promise.all(
      Array.from({ length: workerCount }, (_, w) => worker(w)),
    );
  } finally {
    if (opts.signal) opts.signal.removeEventListener('abort', onCallerAbort);
  }

  return result;
}

/**
 * Bounded-concurrency settled-result runner. Extracted from
 * `src/commands/eval-cross-modal.ts:248-274` so callers don't roll their
 * own.
 *
 * Semantics:
 *   - Up to `limit` items in flight at any moment.
 *   - Per-item errors are CAPTURED into the result array, not thrown
 *     (matches `Promise.allSettled` shape, not `Promise.all`).
 *   - Return array preserves input order regardless of completion order.
 *   - `signal.aborted` short-circuits remaining claims; in-flight items
 *     complete (or throw if the caller's `fn` honors the signal).
 */
export interface RunWithLimitOpts<TIn, TOut> {
  items: readonly TIn[];
  limit: number;
  fn: (item: TIn, idx: number) => Promise<TOut>;
  signal?: AbortSignal;
}

export type SettledItem<TOut> =
  | { ok: true; value: TOut; idx: number }
  | { ok: false; error: unknown; idx: number };

export async function runWithLimit<TIn, TOut>(
  opts: RunWithLimitOpts<TIn, TOut>,
): Promise<SettledItem<TOut>[]> {
  const items = opts.items;
  const total = items.length;
  const out: SettledItem<TOut>[] = new Array(total);
  if (total === 0) return out;

  const workerCount = Math.max(1, Math.min(opts.limit, total));
  // ATOMICITY INVARIANT: same load-bearing claim as runSlidingPool.
  // CI guard pins this too.
  let nextIdx = 0;

  async function worker(): Promise<void> {
    while (true) {
      if (opts.signal?.aborted) return;
      if (nextIdx >= total) return;
      const idx = nextIdx++;
      try {
        const value = await opts.fn(items[idx], idx);
        out[idx] = { ok: true, value, idx };
      } catch (error) {
        out[idx] = { ok: false, error, idx };
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return out;
}
