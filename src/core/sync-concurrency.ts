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

/** Default per-file worker count inside a single source's import phase. */
export const DEFAULT_PARALLEL_WORKERS = 4;

/**
 * v0.40.3.0 — default number of sources synced concurrently under
 * `gbrain sync --all`. Sibling of `DEFAULT_PARALLEL_WORKERS`; the two
 * are deliberately separate constants because they cover different axes:
 *
 *   total live Postgres connections per fan-out wave
 *     ≈  DEFAULT_PARALLEL_SOURCES  ×  DEFAULT_PARALLEL_WORKERS  ×  2
 *           (per-source fan-out)    (per-file workers)        (per-worker pool)
 *
 * Default `4 × 4 × 2 = 32` connections per wave + parent pool. Tuned for
 * a Postgres+pgbouncer setup sized at 40-50 connections. Operators on
 * smaller pools should lower either knob; sync.ts emits a stderr warning
 * when the product exceeds 16 so the operator can size pgbouncer / Postgres
 * `max_connections` accordingly.
 *
 * Conflating these two as one constant was a v0.40.2 footgun that Codex
 * flagged during the v0.40.3.0 plan review. Keeping them separate makes
 * the multiplication visible to future contributors.
 */
export const DEFAULT_PARALLEL_SOURCES = 4;

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

/**
 * v0.41.13.0 — parse a duration argument in seconds for `--timeout` and
 * `--max-age`. Same shape as the existing duration parsers used elsewhere
 * in gbrain (e.g. `gbrain eval prune --older-than`):
 *
 *   "60"   → 60      (bare integer, treated as seconds)
 *   "60s"  → 60
 *   "10m"  → 600
 *   "1h"   → 3600
 *
 * Rejects (throws an Error with the flag name in the message):
 *   - undefined: caller responsibility to detect missing flag
 *   - "" / "abc" / "1.5s" / "60ms" / non-integer counts
 *   - 0 / negative / NaN / Infinity
 *
 * The flag name is passed in so the error message names the actual CLI
 * flag that failed validation, not a generic message.
 */
export function parseDurationSeconds(s: string | undefined, flagName: string): number | undefined {
  if (s === undefined) return undefined;
  const trimmed = s.trim();
  const m = trimmed.match(/^(\d+)([smh]?)$/);
  if (!m) {
    throw new Error(
      `${flagName} must be a positive integer with optional s/m/h suffix (e.g. 60, 60s, 10m, 1h), got: ${JSON.stringify(s)}`,
    );
  }
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n < 1) {
    throw new Error(
      `${flagName} must be a positive integer, got: ${JSON.stringify(s)}`,
    );
  }
  const unit = m[2] || 's';
  if (unit === 's') return n;
  if (unit === 'm') return n * 60;
  if (unit === 'h') return n * 3600;
  // Defensive: regex already rejects other units; this line is unreachable.
  throw new Error(`${flagName}: unsupported unit "${unit}"`);
}

// ────────────────────────────────────────────────────────────────────────
// v0.42.x (#1794, 4A) — connection-budget clamp.
// ────────────────────────────────────────────────────────────────────────

/**
 * Resolve `GBRAIN_MAX_CONNECTIONS` (a positive integer) or undefined when
 * unset/invalid. OPT-IN: when unset, the budget clamp is a no-op and the
 * well-tuned defaults are unchanged. Operators behind a low-cap pooler
 * (Supabase Supavisor's 20-client transaction pooler is the #1794 trigger)
 * set this so a single source's worker fan-out stays under the cap instead of
 * starving retries with EMAXCONNSESSION.
 */
export function resolveMaxConnections(): number | undefined {
  const raw = process.env.GBRAIN_MAX_CONNECTIONS;
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/**
 * Clamp a single sync's worker count so its connection footprint
 * (`parentPool + workers * perWorkerPool`) stays at or under `maxConnections`.
 *
 * Pure. No-op (returns `workers` unchanged, `clamped:false`) when
 * `maxConnections` is undefined — preserving every existing brain's behavior.
 * When even one worker won't fit (`parentPool + perWorkerPool > budget`),
 * returns 1: the caller's serial path uses only the parent pool, and the
 * doctor nudge tells the operator to lower `GBRAIN_POOL_SIZE`.
 *
 * Deliberately clamps only the worker COUNT (not per-worker poolSize) — the
 * dominant lever — to keep the clamp narrow per the 4A scope.
 */
export function clampWorkersForConnectionBudget(
  workers: number,
  opts: { maxConnections?: number; parentPool: number; perWorkerPool: number },
): { workers: number; clamped: boolean } {
  const { maxConnections, parentPool, perWorkerPool } = opts;
  if (maxConnections === undefined || perWorkerPool <= 0) {
    return { workers, clamped: false };
  }
  const maxWorkers = Math.floor((maxConnections - parentPool) / perWorkerPool);
  if (maxWorkers < 1) return { workers: 1, clamped: workers > 1 };
  if (workers > maxWorkers) return { workers: maxWorkers, clamped: true };
  return { workers, clamped: false };
}

// ────────────────────────────────────────────────────────────────────────
// v0.41.16.0 — D9 wrapper for bulk-command --workers.
// ────────────────────────────────────────────────────────────────────────

/**
 * Stable, machine-readable result of `resolveWorkersWithClamp`. CLI
 * callers can branch on `wasClamped` to decide whether to print a
 * follow-up hint; tests pin every field for regression coverage.
 */
export interface WorkersWithClampResult {
  /** Effective worker count after clamp + auto rules. Always >= 1. */
  workers: number;
  /** True when override was set AND clamped down (PGLite case). */
  wasClamped: boolean;
  /** The original override the caller asked for. undefined if none. */
  requested: number | undefined;
  /**
   * Reason the wrapper picked `workers`. Used by tests + stderr-line
   * shape; one of: 'pglite_clamp' | 'override' | 'auto' | 'default'.
   */
  reason: 'pglite_clamp' | 'override' | 'auto' | 'default';
}

/**
 * Module-scoped memo so `resolveWorkersWithClamp` emits the PGLite
 * clamp warning at most once per (command, requested) pair within a
 * single CLI process. Without it, every per-source loop iteration
 * inside a fan-out command (`gbrain sync --all` + per-source workers)
 * would print the same warning N times. Pure module-state — tests can
 * reset via `_resetWorkersClampWarningsForTest()`.
 */
const _warnedClampKeys = new Set<string>();

/** Test seam: clear the warned-once set so re-runs emit again. */
export function _resetWorkersClampWarningsForTest(): void {
  _warnedClampKeys.clear();
}

/**
 * Resolve a bulk command's effective worker count, applying the PGLite
 * single-writer clamp and emitting one stderr warning per (command,
 * requested) pair when the clamp fires.
 *
 * Wraps `autoConcurrency` rather than mutating it (codex finding #14 —
 * `autoConcurrency` is silent today and shared by sync/import callers
 * that should NOT inherit per-command stderr lines). The wrapper is the
 * single source of truth for bulk-command CLI flag resolution; embed.ts
 * is the lone legacy caller that bypasses it (`GBRAIN_EMBED_CONCURRENCY
 * || 20` semantics preserved per codex finding #13).
 *
 * Rules (in order):
 *   1. PGLite engine + override > 1 → return 1, set wasClamped=true,
 *      emit stderr line ONCE per (commandName, requested) pair.
 *   2. PGLite engine + no override → return 1 (silent — that's just
 *      the default for the engine).
 *   3. Postgres + explicit override → return override clamped to >= 1.
 *   4. Postgres + no override + fileCount > AUTO_CONCURRENCY_FILE_THRESHOLD →
 *      return DEFAULT_PARALLEL_WORKERS.
 *   5. Postgres + no override + small fileCount → return 1.
 *
 * The PGLite warning text matches CLAUDE.md house style:
 *   [extract-conversation-facts] workers=20 requested, clamped to 1
 *     on PGLite (single-writer engine; use Postgres for parallel writes)
 *
 * @param engine     The active brain engine (PGLite vs Postgres branch).
 * @param override   Caller's explicit --workers N value; undefined when
 *                   no flag was passed.
 * @param commandName Identifying string for the stderr line and dedup
 *                   key. Use the user-facing CLI command name (e.g.
 *                   'extract-conversation-facts', 'reindex-code').
 * @param fileCount  Total work count, used by auto-concurrency branch.
 *                   Pass 0 when unknown; auto path will return 1.
 */
export function resolveWorkersWithClamp(
  engine: BrainEngine,
  override: number | undefined,
  commandName: string,
  fileCount: number,
): WorkersWithClampResult {
  if (engine.kind === 'pglite') {
    if (override !== undefined && override > 1) {
      const key = `${commandName}:${override}`;
      if (!_warnedClampKeys.has(key)) {
        _warnedClampKeys.add(key);
        // eslint-disable-next-line no-console
        console.error(
          `[${commandName}] workers=${override} requested, clamped to 1 on PGLite ` +
            '(single-writer engine; use Postgres for parallel writes)',
        );
      }
      return {
        workers: 1,
        wasClamped: true,
        requested: override,
        reason: 'pglite_clamp',
      };
    }
    return {
      workers: 1,
      wasClamped: false,
      requested: override,
      reason: override !== undefined ? 'override' : 'default',
    };
  }

  // Postgres path: defer to existing autoConcurrency for the rule set.
  const workers = autoConcurrency(engine, fileCount, override);
  let reason: WorkersWithClampResult['reason'];
  if (override !== undefined) reason = 'override';
  else if (fileCount > AUTO_CONCURRENCY_FILE_THRESHOLD) reason = 'auto';
  else reason = 'default';
  return { workers, wasClamped: false, requested: override, reason };
}
