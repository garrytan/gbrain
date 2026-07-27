/**
 * abort-check.ts — one canonical place for cooperative-abort checks (#1737).
 *
 * gbrain has several long-running loops (embed --stale, embed --all, dream
 * cycle phases) that each grew their own `signal?.aborted` check. When a job
 * is killed by the Minions worker (wall-clock timeout, lock loss, SIGTERM) the
 * handler keeps running unless every loop cooperatively checks its signal — and
 * a missed loop is exactly the daily cycle-wedge in #1737: the embed phase ran
 * to completion ignoring the abort, so `gbrain_cycle_locks` stayed held and
 * every later autopilot cycle skipped with `cycle_already_running`.
 *
 *   ┌── worker fires job.signal.abort() ──┐
 *   │  (wall-clock / lock-loss / SIGTERM) │
 *   └──────────────┬─────────────────────┘
 *                  ▼
 *   handler → runPhaseEmbed → runEmbedCore → embedAll(Stale)
 *                  │                              │
 *                  └─ throwIfAborted(signal) ─────┘  ← bail here, not 15 min later
 *                  ▼
 *   finally releases gbrain_cycle_locks → next cycle runs
 *
 * Two shapes, because the call sites want different control flow:
 *   - `isAborted(signal)`      — boolean; for loops that `break` cleanly and
 *                                return partial progress (embed loops).
 *   - `throwIfAborted(signal)` — throws an AbortError; for phase boundaries
 *                                that want to unwind to the cycle's finally.
 */

/** True iff the signal exists and has fired. Null/undefined → never aborted. */
export function isAborted(signal?: AbortSignal | null): boolean {
  return !!signal?.aborted;
}

/** Error thrown by {@link throwIfAborted}; `name === 'AbortError'`. */
export class AbortError extends Error {
  constructor(message = 'aborted') {
    super(message);
    this.name = 'AbortError';
  }
}

/**
 * Throw an {@link AbortError} if the signal has fired. The thrown message
 * prefers the signal's own `reason` (the worker sets it to the abort cause —
 * 'wall-clock', 'lock-lost', 'shutdown') so the unwind is self-describing.
 */
export function throwIfAborted(signal?: AbortSignal | null, label?: string): void {
  if (!signal?.aborted) return;
  const reason =
    signal.reason instanceof Error
      ? signal.reason.message
      : String(signal.reason ?? 'aborted');
  throw new AbortError(label ? `${label}: ${reason}` : reason);
}

/**
 * Compose an external abort signal with an internal one (e.g. a wall-clock
 * budget timer) so a single combined signal fires when EITHER does. Returns
 * the internal signal unchanged when there's no external signal, so callers
 * that never pass one pay nothing. Uses the platform `AbortSignal.any` (Node
 * 20+/Bun) and falls back to a manual relay if it's somehow unavailable.
 */
export function anySignal(
  internal: AbortSignal,
  external?: AbortSignal | null,
): AbortSignal {
  if (!external) return internal;
  if (typeof (AbortSignal as { any?: unknown }).any === 'function') {
    return (AbortSignal as unknown as { any(s: AbortSignal[]): AbortSignal }).any([
      internal,
      external,
    ]);
  }
  // Fallback relay (older runtimes): forward whichever fires first.
  const ac = new AbortController();
  const relay = (s: AbortSignal) => ac.abort(s.reason);
  if (internal.aborted) relay(internal);
  else internal.addEventListener('abort', () => relay(internal), { once: true });
  if (external.aborted) relay(external);
  else external.addEventListener('abort', () => relay(external), { once: true });
  return ac.signal;
}
