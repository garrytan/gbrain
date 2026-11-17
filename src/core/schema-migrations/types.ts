/**
 * The schema migration record type. Re-exported from src/core/migrate.ts.
 * Leaf module: it must never import src/core/migrate.ts.
 */
import type { BrainEngine } from '../engine.ts';

/**
 * Schema migrations — run automatically on initSchema().
 *
 * Each migration is a version number + idempotent SQL. Migrations are embedded
 * as string constants (Bun's --compile strips the filesystem).
 *
 * Each migration runs in a transaction: if the SQL fails, the version stays
 * where it was and the next run retries cleanly.
 *
 * Migrations can also include a handler function for application-level logic
 * (e.g., data transformations that need TypeScript, not just SQL).
 */

export interface Migration {
  version: number;
  name: string;
  /** Engine-agnostic SQL. Used when `sqlFor` is absent. Set to '' for handler-only or sqlFor-only migrations. */
  sql: string;
  /**
   * Engine-specific SQL. If present, overrides `sql` for the matching engine.
   * Needed when Postgres wants CONCURRENTLY but PGLite can't honor it.
   */
  sqlFor?: { postgres?: string; pglite?: string };
  /**
   * When false, the runner does NOT wrap the SQL in `engine.transaction()`.
   * Required for `CREATE INDEX CONCURRENTLY` (which Postgres refuses inside a transaction).
   * Enforced Postgres-only; ignored on PGLite (PGLite has no concurrent writers anyway).
   * Defaults to true.
   */
  transaction?: boolean;
  handler?: (engine: BrainEngine) => Promise<void>;
  /**
   * v0.30.1 (D6): when undefined, treated as `true` for all existing
   * migrations (every migration in the registry uses CREATE ... IF NOT
   * EXISTS / ALTER ... IF NOT EXISTS / INSERT ... ON CONFLICT, so re-running
   * is safe). Explicit `idempotent: false` blocks the verify-hook
   * self-healing path from re-running a destructive migration; the runner
   * surfaces `MigrationDriftError` and requires `--skip-verify` to force.
   *
   * NEW migrations should declare this explicitly; the CONTRIBUTING
   * migration template lists it as required for clarity.
   */
  idempotent?: boolean;
  /**
   * v0.30.1 (D6): post-condition probe. Runs after the migration claims
   * to have applied. Returns false if the actual schema state doesn't
   * match what the migration declared (e.g. column/table/index missing
   * after a partially-committed run on a wedged Supabase pooler).
   *
   * Verify-hook coverage is OPT-IN per migration. Per X3 / codex C6 the
   * v0.30.1 surface ships verify hooks only on a small set of migrations;
   * older migrations rely on `gbrain upgrade --force-schema` for recovery.
   */
  verify?: (engine: BrainEngine) => Promise<boolean>;
}
