/**
 * Deadline-bounded polling for tests that await an async condition (a file
 * appearing, a child writing a row, a heartbeat firing). Replaces bare
 * `await sleep(N)` guesses — the poll returns as soon as the condition holds
 * and fails loudly (label + elapsed) instead of flaking on slow machines.
 *
 * The predicate is checked at least once even with timeoutMs <= 0.
 */
export interface WaitForOpts {
  /** Deadline. Default 5000ms. */
  timeoutMs?: number;
  /** Poll interval. Default 10ms. */
  intervalMs?: number;
  /** Names the condition in the timeout error. */
  label?: string;
}

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  opts: WaitForOpts = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const intervalMs = opts.intervalMs ?? 10;
  const start = Date.now();
  for (;;) {
    if (await predicate()) return;
    const elapsed = Date.now() - start;
    if (elapsed >= timeoutMs) {
      const label = opts.label ? `${opts.label}: ` : '';
      throw new Error(
        `waitFor: ${label}condition still false after ${elapsed}ms (timeout ${timeoutMs}ms)`,
      );
    }
    // Clamp the final sleep to the remaining deadline so a coarse interval
    // can't overshoot the timeout by a full interval. (A predicate that HANGS
    // is out of scope by design — bun's per-test --timeout is that backstop.)
    await new Promise<void>(resolve => setTimeout(resolve, Math.min(intervalMs, timeoutMs - elapsed)));
  }
}

/**
 * Poll `fn` until it yields a non-null, non-undefined value; return it.
 * Same deadline/label semantics as waitFor.
 */
export async function waitForValue<T>(
  fn: () => T | undefined | null | Promise<T | undefined | null>,
  opts: WaitForOpts = {},
): Promise<T> {
  let value: T | undefined | null;
  await waitFor(async () => {
    value = await fn();
    return value !== undefined && value !== null;
  }, opts);
  return value as T;
}
