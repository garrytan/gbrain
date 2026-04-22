/**
 * Failure-backoff helper for `gbrain autopilot` (issue #168).
 *
 * Pre-v0.14.3 autopilot exited hard after 5 consecutive failures, which
 * a single transient Postgres event (pgbouncer reset, Supabase minor
 * version upgrade, network blip) could easily trip. This helper returns
 * the new error counter, the sleep interval before the next cycle, and
 * whether the daemon should exit.
 *
 * Kept in its own module so it can be unit-tested without driving the
 * infinite daemon loop in autopilot.ts.
 */

export interface FailureState {
  consecutiveErrors: number;
}

export interface FailureOpts {
  /** Counter value at or above which `shouldExit` flips to true. */
  maxErrors: number;
  /** Base cycle interval in ms. */
  baseIntervalMs: number;
  /** Optional ceiling on the backoff sleep. Default 30 minutes. */
  backoffCapMs?: number;
}

export interface FailureResult {
  consecutiveErrors: number;
  sleepMs: number;
  shouldExit: boolean;
}

export const DEFAULT_MAX_CONSECUTIVE_ERRORS = 20;
export const DEFAULT_BACKOFF_CAP_MS = 30 * 60_000;

/**
 * Compute the next sleep interval and whether the daemon should stop.
 *
 * Exponential growth starting at baseIntervalMs: 1x, 2x, 4x, 8x, ..., capped.
 * The exponent is clamped so a long run of failures can't overflow.
 */
export function computeFailureBackoff(
  state: FailureState,
  opts: FailureOpts,
): FailureResult {
  const next = state.consecutiveErrors + 1;
  const shouldExit = next >= opts.maxErrors;
  const cap = opts.backoffCapMs ?? DEFAULT_BACKOFF_CAP_MS;
  const exponent = Math.min(next - 1, 10);
  const sleepMs = Math.min(opts.baseIntervalMs * Math.pow(2, exponent), cap);
  return { consecutiveErrors: next, sleepMs, shouldExit };
}
