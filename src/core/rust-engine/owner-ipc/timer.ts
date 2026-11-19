/**
 * A timeout for deadlines that can be far away. setTimeout takes a 32-bit signed delay: a longer one (a deadline more
 * than about 24.8 days out) is set to 1 ms, so the owner socket would end the call with `timeout` at once. This timer
 * waits in steps of at most MAX_TIMER_DELAY_MS and re-arms until the due time, then runs `fire` once.
 */

/** The longest delay setTimeout keeps: 2^31 - 1 ms. */
export const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

export interface DeadlineTimer {
  clear(): void;
}

/**
 * Runs `fire` once, `ms` after now. `unref` lets the process exit while the timer waits. `stepMs` is the longest single
 * setTimeout delay; only tests lower it, to show the re-arm without waiting weeks.
 */
export function setDeadlineTimer(fire: () => void, ms: number, opts: { unref?: boolean; stepMs?: number } = {}): DeadlineTimer {
  const step = Math.min(MAX_TIMER_DELAY_MS, Math.max(1, opts.stepMs ?? MAX_TIMER_DELAY_MS));
  const due = Date.now() + Math.max(0, Number.isFinite(ms) ? ms : MAX_TIMER_DELAY_MS);
  let handle: ReturnType<typeof setTimeout> | undefined;
  let cleared = false;
  const arm = () => {
    if (cleared) return;
    const left = due - Date.now();
    handle = left > step ? setTimeout(arm, step) : setTimeout(() => { if (!cleared) { cleared = true; fire(); } }, Math.max(0, left));
    if (opts.unref) handle.unref?.();
  };
  arm();
  return { clear: () => { cleared = true; if (handle) clearTimeout(handle); } };
}
