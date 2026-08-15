/**
 * Promise-race timeout helper.
 *
 * v0.41.6.0 D3 — single source of truth for CLI command timeouts. Wraps
 * a promise; rejects with `OperationTimeoutError` if it doesn't settle
 * within `ms`. The user-facing error message names the label and the
 * elapsed deadline.
 *
 * IMPORTANT (per eng-review D14 + outside-voice F2): this wrapper does
 * NOT cancel the underlying promise. The wrapped promise keeps running
 * in the background until it settles or the process exits. For CLI
 * callers, `process.exit()` is the real resource-release mechanism —
 * the kernel reclaims open sockets, the Postgres server will eventually
 * error out the abandoned query, and the AI SDK call dies when its
 * underlying socket closes.
 *
 * For non-CLI callers that need TRUE cancellation (server-side resource
 * release, in-process cleanup), thread `AbortSignal` end-to-end through
 * the call chain instead. Promise.race only bounds USER wait, not server
 * work.
 *
 * Usage:
 *   try {
 *     const result = await withTimeout(longRunningThing(), 30_000, 'gbrain search');
 *   } catch (e) {
 *     if (e instanceof OperationTimeoutError) {
 *       console.error(`${e.label} timed out after ${e.ms}ms. Override with --timeout=Ns.`);
 *       process.exit(124); // GNU timeout convention
 *     }
 *     throw e;
 *   }
 */

export class OperationTimeoutError extends Error {
  readonly label: string;
  readonly ms: number;

  constructor(label: string, ms: number) {
    super(`Operation "${label}" timed out after ${ms}ms`);
    this.name = 'OperationTimeoutError';
    this.label = label;
    this.ms = ms;
  }
}

/**
 * Race `p` against a `ms`-millisecond timeout. Rejects with
 * `OperationTimeoutError` when the deadline passes. The timer is cleared
 * on settle (resolve or reject) so successful calls don't leak pending
 * `setTimeout` handles.
 *
 * `ms` must be a positive integer; values <= 0 reject immediately, which
 * is usually a caller bug. Pass `Number.POSITIVE_INFINITY` to effectively
 * disable the timeout (use only for explicit override paths).
 */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  if (!Number.isFinite(ms)) {
    // Infinity → no timeout (explicit opt-out). Pass through unchanged.
    return p;
  }
  if (ms <= 0) {
    return Promise.reject(new OperationTimeoutError(label, ms));
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new OperationTimeoutError(label, ms)), ms);
    // Don't keep the event loop alive just for the timeout — if the wrapped
    // promise settles first, we clear; if nothing else is running, the
    // process can exit cleanly without waiting on this timer.
    if (typeof (timer as { unref?: () => void }).unref === 'function') {
      (timer as { unref: () => void }).unref();
    }
  });

  return Promise.race([p, timeoutPromise]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
