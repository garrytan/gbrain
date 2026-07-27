/**
 * OS scheduling priority (niceness) helpers for the Minions jobs subsystem.
 *
 * The lever behind issue #1815: background jobs (sync, embed, extract, subagent
 * fans) can run at full concurrency yet drive machine load average high enough to
 * starve the interactive shell. Reniceing the supervisor → worker → spawned-child
 * tree to a low priority lets the work run full-width when the box is idle and
 * politely yield when it isn't — load drops with zero throughput loss.
 *
 * Niceness range is POSIX `[-20, 19]` (-20 = highest priority, 19 = lowest /
 * "nicest"). Positive values need no privilege; negative values (raise priority)
 * require root and fail EPERM, OR partially clamp to RLIMIT_NICE *without
 * throwing*. Both cases are handled by always re-reading the effective value.
 *
 * This module is the pure, testable core: the CLI layer (src/commands/jobs.ts)
 * owns the side effect of actually calling it, the same boundary that keeps
 * worker.ts/supervisor.ts free of process.exit.
 */

import { setPriority as osSetPriority, getPriority as osGetPriority } from 'os';

/** Lowest (highest-priority) and highest (nicest) POSIX nice values. */
export const NICE_MIN = -20;
export const NICE_MAX = 19;

export interface ApplyNicenessResult {
  /** True when setPriority did not throw. A `false` here is the divergence signal. */
  applied: boolean;
  /** The niceness the caller asked for. */
  requested: number;
  /**
   * The niceness actually in effect AFTER the attempt, re-read via getPriority.
   * Distinct from `requested` when the kernel clamped (RLIMIT_NICE) or the set
   * was denied (EPERM → stays at the inherited value, typically 0). `null` only
   * when the re-read itself failed.
   */
  effective: number | null;
  /** Present when setPriority threw (e.g. "EACCES" / "EPERM"). */
  error?: string;
}

/**
 * Parse a `--nice <n>` value. Whole-string integer parse — `parseInt` would
 * wrongly accept "3.5" → 3 and "10abc" → 10 (Codex #3). Mirrors the
 * `String(n) !== s.trim()` guard in src/core/sync-concurrency.ts:parseWorkers.
 * Throws on non-integer or out-of-range input; the CLI wraps this with exit(1).
 */
export function parseNiceValue(raw: string): number {
  const s = raw.trim();
  const n = parseInt(s, 10);
  if (!Number.isFinite(n) || String(n) !== s) {
    throw new Error(`--nice must be an integer in [${NICE_MIN}, ${NICE_MAX}], got: ${JSON.stringify(raw)}`);
  }
  if (n < NICE_MIN || n > NICE_MAX) {
    throw new Error(`--nice must be in [${NICE_MIN}, ${NICE_MAX}] (-20 = highest priority, 19 = nicest), got: ${n}`);
  }
  return n;
}

/**
 * Apply niceness to the CURRENT process (pid 0). Always re-reads the effective
 * value afterwards — in BOTH the success and failure paths (Codex #4) — so a
 * denied renice records `effective: 0`, not `null`, and doctor can distinguish
 * "permission denied but still running at 0" from "could not measure".
 *
 * `setPriority`/`getPriority` are injectable for tests.
 */
export function applyNiceness(
  nice: number,
  setPriority: (pid: number, priority: number) => void = osSetPriority,
  getPriority: (pid: number) => number = osGetPriority,
): ApplyNicenessResult {
  let applied = false;
  let error: string | undefined;
  try {
    setPriority(0, nice);
    applied = true;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  // Re-read regardless of outcome (catches RLIMIT_NICE clamp on success and the
  // unchanged inherited value on failure).
  let effective: number | null;
  try {
    effective = getPriority(0);
  } catch {
    effective = null;
  }

  return { applied, requested: nice, effective, error };
}

/**
 * Read the effective niceness of an arbitrary pid. Used by the read surfaces
 * (jobs stats, doctor, supervisor status). Returns null when the pid is gone or
 * unreadable. getpriority(2) needs no ownership to read on Linux/macOS.
 */
export function getEffectiveNiceness(
  pid: number,
  getPriority: (pid: number) => number = osGetPriority,
): number | null {
  try {
    return getPriority(pid);
  } catch {
    return null;
  }
}

/** Format a nice value for human output: `+10`, `0`, `-5`. */
export function formatNice(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}
