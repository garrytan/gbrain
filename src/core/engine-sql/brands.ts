/**
 * RLS read brands for engine-sql (refactor wave 1, EO4; docs/guides/rls-and-you.md).
 *
 * Every engine-sql read function declares how master scoped it, and the type
 * system holds callers to it:
 *
 *   ScopedRead          the read ran inside `PostgresEngine#withScopedReadTransaction`
 *                       on master (RLS `app.scopes` bound when
 *                       GBRAIN_RLS_SCOPE_BINDING is on). Obtain ONLY from
 *                       `scopedRead(executor)` on the handle that helper yields;
 *                       PGLite has no RLS, so its engine brands its own executor.
 *   LegacyUnscopedRead  the read ran on the pool with no scope transaction on
 *                       master. Obtain ONLY from `unscopedExecutor(executor, reason)`.
 *                       Widening a read to ScopedRead is a behavior change
 *                       (new transaction + pool hold, the #1794 class): TODO,
 *                       never a drive-by.
 *
 * The brand keys spell out the factory, so a missing brand reads as
 * "Property '__obtainViaWithScopedReadTransaction' is missing". This module is
 * the only place allowed to mention them: `scripts/check-engine-sql-brands.ts`
 * fails on a brand key anywhere else, on `as unknown as` next to executor
 * types, and on `unscopedExecutor` / `LegacyUnscopedRead` imports outside the
 * engine façades, engine-sql, doctor, maintenance, admin and migrations
 * (never `src/core/ops/**`, the MCP-facing surface).
 */

import type { SqlExecutor } from './executor.ts';

/** Obtain via `scopedRead()` inside `withScopedReadTransaction` (identity on PGLite). */
export type ScopedRead = SqlExecutor & { readonly __obtainViaWithScopedReadTransaction: true };

/** Obtain via `unscopedExecutor(executor, reason)`: a read master ran unscoped on the pool. */
export type LegacyUnscopedRead = SqlExecutor & { readonly __obtainViaUnscopedExecutor: true };

/**
 * Brand the executor over the handle `withScopedReadTransaction` yielded.
 * Call it on that callback's `tx` (Postgres) or on the engine executor
 * (PGLite, which has no RLS layer); nowhere else.
 */
export function scopedRead(executor: SqlExecutor): ScopedRead {
  return executor as ScopedRead;
}

/**
 * The sanctioned escape hatch for reads that were unscoped on master, and for
 * doctor / maintenance / admin / migration reads. `reason` is documentation
 * for reviewers (it is not stored); keep it specific.
 */
export function unscopedExecutor(executor: SqlExecutor, reason: string): LegacyUnscopedRead {
  void reason;
  return executor as LegacyUnscopedRead;
}
