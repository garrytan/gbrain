/**
 * Leaf module (no imports) so callers outside the cycle orchestrator, like the
 * extract_atoms drain, can combine signals without loading `cycle.ts`.
 * `cycle.ts` re-exports `anyAbortSignal` for existing import sites.
 */

/**
 * Combine abort signals (external caller signal + internal controllers such
 * as a lock-steal or deadline controller) into one REAL AbortSignal.
 *
 * Deliberately NOT AbortSignal.any: CycleOpts.signal has always been duck-
 * typed in practice (test stubs pass `{ aborted: false }` and flip the flag;
 * the raw object used to flow straight into checkAborted, which only reads
 * `.aborted`/`.reason`). AbortSignal.any throws ERR_INVALID_ARG_TYPE on
 * those. Manual fan-in: real signals propagate via listener; listener-less
 * stubs are polled at 50ms — semantically the flip is seen within a tick,
 * and the RETURNED signal is a genuine AbortSignal so phases can hand it to
 * fetch/timers safely.
 *
 * ALWAYS call dispose() when the consuming scope ends: the forward listeners
 * live on the CALLER's signals, and long-lived callers (the autopilot daemon
 * passes its daemon-lifetime shutdown signal into every cycle tick) would
 * otherwise accumulate one listener + captured controller per invocation.
 */
export function anyAbortSignal(signals: AbortSignal[]): { signal: AbortSignal; dispose: () => void } {
  const c = new AbortController();
  const cleanups: Array<() => void> = [];
  const forward = (s: AbortSignal) => { if (!c.signal.aborted) c.abort(s.reason); };
  for (const s of signals) {
    if (!s) continue;
    if (s.aborted) { forward(s); break; }
    if (typeof (s as Partial<AbortSignal>).addEventListener === 'function') {
      const listener = () => forward(s);
      s.addEventListener('abort', listener, { once: true });
      cleanups.push(() => s.removeEventListener('abort', listener));
    } else {
      const t = setInterval(() => { if (s.aborted) { forward(s); clearInterval(t); } }, 50);
      (t as unknown as { unref?: () => void }).unref?.();
      c.signal.addEventListener('abort', () => clearInterval(t), { once: true });
      cleanups.push(() => clearInterval(t));
    }
  }
  return {
    signal: c.signal,
    dispose: () => { for (const fn of cleanups) { try { fn(); } catch { /* best effort */ } } },
  };
}
