/**
 * Process-wide forward-progress signal.
 *
 * A long-running command proves it is still doing useful work by calling
 * `noteForwardProgress()` whenever a unit of work completes (the shared
 * progress reporter calls it on every `tick`). Deadlines that must never kill
 * a run that is still progressing (the sync hard deadline, the serve boot
 * deadline) subscribe with `onForwardProgress` and extend themselves while
 * the signal keeps arriving. Heartbeats are NOT progress: a timer firing says
 * the event loop is alive, not that work is finishing.
 *
 * Zero imports on purpose: `progress.ts` (zero-dependency) and the watchdogs
 * both depend on it.
 */

type ForwardProgressListener = () => void;

const listeners = new Set<ForwardProgressListener>();
let lastProgressAt = 0;

/** Record that a unit of work just completed. Cheap enough to call per item. */
export function noteForwardProgress(): void {
  lastProgressAt = Date.now();
  for (const listener of listeners) {
    try { listener(); } catch { /* a listener must never break the work loop */ }
  }
}

/** Subscribe to forward-progress notes; returns the unsubscribe function. */
export function onForwardProgress(listener: ForwardProgressListener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Wall-clock ms of the most recent progress note in this process (0 = none yet). */
export function lastForwardProgressAt(): number {
  return lastProgressAt;
}

/**
 * #5984: the process's out-of-band stop time, registered by the CLI when it
 * arms the sync watchdog. `strict` deadlines stop at `atMs` regardless of
 * progress; progress-aware ones extend while progress keeps arriving. A
 * long-running loop stops itself before a strict deadline so it, not the
 * watchdog, writes the final result.
 */
/** `progressWindowMs`: a progress-aware deadline stops only once this long passed without progress (#6712 PR 1: a drain-lease follower's budget). */
export interface RunDeadline { atMs: number; strict: boolean; progressWindowMs?: number }
let runDeadline: RunDeadline | null = null;
export function registerRunDeadline(deadline: RunDeadline | null): void {
  runDeadline = deadline;
}
export function currentRunDeadline(): RunDeadline | null {
  return runDeadline;
}
