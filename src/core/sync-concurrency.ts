/**
 * Shared concurrency policy for sync + import + jobs paths.
 *
 * Three callers used to embed three different policies:
 *   - performSync (incremental): >100 files → 4 workers
 *   - performFullSync: Postgres → 4 workers
 *   - jobs.ts sync handler: hardcoded 4
 *
 * They drift over time and confuse users ("why does my sync not parallelize?"
 * is a different answer in each path). This module is one source of truth.
 *
 * v0.22.13 — extracted as part of the parallel-sync hardening (PR #490).
 */
import type { BrainEngine } from './engine.ts';

/** Threshold above which auto-concurrency fires for incremental sync paths. */
export const AUTO_CONCURRENCY_FILE_THRESHOLD = 100;

/** Minimum file count below which the parallel branch is skipped even when
 * auto-concurrency would otherwise fire. Prevents spawning workers for trivial
 * diffs where setup cost exceeds parallelism gains. Only consulted on the
 * auto path; explicit `--workers N` bypasses this. */
export const PARALLEL_FILE_FLOOR = 50;

/** Default worker count when auto-concurrency fires. */
export const DEFAULT_PARALLEL_WORKERS = 4;

/**
 * Resolve effective worker count for a sync/import operation.
 *
 * Inputs:
 *   - engine.kind: 'pglite' always returns 1 (single-connection)
 *   - override: caller's explicit --workers / opts.concurrency value
 *   - fileCount: size of the work batch
 *
 * Rules:
 *   - PGLite → always 1 (the engine is single-connection regardless)
 *   - explicit override → respect it (clamped to >=1)
 *   - auto path → DEFAULT_PARALLEL_WORKERS when fileCount > AUTO_CONCURRENCY_FILE_THRESHOLD, else 1
 *
 * Note: this function does NOT consult PARALLEL_FILE_FLOOR. The floor is a
 * caller-side gate that decides whether to take the parallel code path even
 * when the worker count is > 1. It only applies to the auto path; explicit
 * --workers bypasses the floor entirely (per Q1 in PR #490).
 */
export function autoConcurrency(
  engine: BrainEngine,
  fileCount: number,
  override?: number,
): number {
  if (engine.kind === 'pglite') return 1;
  if (override !== undefined) return Math.max(1, override);
  return fileCount > AUTO_CONCURRENCY_FILE_THRESHOLD
    ? DEFAULT_PARALLEL_WORKERS
    : 1;
}

/**
 * Decide whether the parallel code path should run.
 *
 *   - workers <= 1 → never parallel
 *   - workers > 1 + explicit override → always parallel (user opted in,
 *     respect them even on small diffs — Q1 in PR #490)
 *   - workers > 1 + auto path → parallel only when fileCount > PARALLEL_FILE_FLOOR
 */
export function shouldRunParallel(
  workers: number,
  fileCount: number,
  explicit: boolean,
): boolean {
  if (workers <= 1) return false;
  if (explicit) return true;
  return fileCount > PARALLEL_FILE_FLOOR;
}

/**
 * Parse a `--workers N` / `--concurrency N` CLI argument value.
 *
 * Returns:
 *   - undefined when the flag was not provided
 *   - a positive integer when the flag was provided with a valid value
 *
 * Throws on:
 *   - non-integer ("foo", "1.5", "")
 *   - zero or negative ("0", "-3")
 *   - NaN / Infinity
 *
 * Q2 in PR #490: the prior parseInt-with-no-validation accepted `--workers 0`
 * and silently fell through to auto-concurrency (4 workers), the opposite of
 * what the user typed. Fail loud instead.
 */
export function parseWorkers(s: string | undefined): number | undefined {
  if (s === undefined) return undefined;
  const n = parseInt(s, 10);
  if (!Number.isFinite(n) || n < 1 || String(n) !== s.trim()) {
    throw new Error(
      `--workers must be a positive integer, got: ${JSON.stringify(s)}`,
    );
  }
  return n;
}
