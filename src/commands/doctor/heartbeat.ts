/**
 * Non-TTY doctor heartbeat budget (agent-first operator wave E11): an agent
 * reading doctor's stderr through a pipe gets at most one heartbeat line per
 * HEARTBEAT_MIN_GAP_MS. A check that runs longer than the gap still gets its
 * line (the next heartbeat after a slow check is always due), and a run that
 * stopped on a fatal error emits nothing more. TTY output (rewritten in place)
 * and quiet / --progress-json progress are unchanged.
 */
import type { ProgressReporter } from '../../core/progress.ts';
import { getCliOptions } from '../../core/cli-options.ts';

export const HEARTBEAT_MIN_GAP_MS = 5_000;

export function throttleDoctorHeartbeat(
  inner: ProgressReporter,
  opts: { tty?: boolean; now?: () => number; gapMs?: number } = {},
): ProgressReporter {
  if (opts.tty ?? (process.stderr.isTTY === true || getCliOptions().progressJson)) return inner;
  const now = opts.now ?? Date.now;
  const gap = opts.gapMs ?? HEARTBEAT_MIN_GAP_MS;
  let last = Number.NEGATIVE_INFINITY;
  return {
    start: (phase, total) => { last = now(); inner.start(phase, total); },
    tick: (n, note) => inner.tick(n, note),
    heartbeat(note) {
      const t = now();
      if (t - last < gap) return;
      last = t;
      inner.heartbeat(note);
    },
    finish: (note) => inner.finish(note),
    child: (phase, total) => inner.child(phase, total),
  };
}
