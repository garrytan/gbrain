/**
 * Shared helpers for schema migrations (src/core/schema-migrations/v<NNN>-*.ts).
 *
 * Leaf module: migration files and the runner in src/core/migrate.ts import
 * from here; nothing under src/core/schema-migrations/ may import migrate.ts
 * (ESM import cycle -> TDZ at module load, including in the compiled binary).
 */
import type { BrainEngine } from '../engine.ts';

/**
 * When true, per-migration explanatory notices (e.g. the v123/v124 "here is
 * what this migration changed" lines that specific handlers write to stderr)
 * are suppressed. Set by runMigrations for a FRESH-install full replay — those
 * notices are useful diagnostics on an UPGRADE but pure noise as a new user's
 * first-run output. Module-level (not threaded through the Migration type)
 * because only a couple of handlers emit them. Guarded via `migrationNotice`.
 * Known limitation: concurrent runMigrations calls in one process (two engines
 * migrating simultaneously) share this flag — worst case is a suppressed or
 * extra stderr NOTICE line; migration execution/stamping is unaffected.
 */
let quietMigrationNotices = false;

/** Write a per-migration explanatory notice unless fresh-install quiet mode is
 *  on. Handlers should route their "what changed" lines through this. */
export function migrationNotice(line: string): void {
  if (quietMigrationNotices) return;
  process.stderr.write(line);
}

/** Runner-only: toggles fresh-install quiet mode for `migrationNotice`. */
export function setQuietMigrationNotices(quiet: boolean): void {
  quietMigrationNotices = quiet;
}

/**
 * Postgres-only: drops `indexName` iff it currently exists AND is invalid — the
 * leftover of a `CREATE INDEX CONCURRENTLY` that failed partway through. Callers
 * MUST already be inside an `engine.kind === 'postgres'` branch (PGLite has no
 * concurrent-build invalid-index concept and no `pg_index` catalog in the same
 * shape) and MUST run this before their own `CREATE INDEX CONCURRENTLY IF NOT
 * EXISTS`, since a stale invalid entry blocks the create from ever landing.
 *
 * Deliberately does NOT wrap the drop in `DO $$ ... EXECUTE '...' END $$`
 * (#1178): Postgres rejects `CONCURRENTLY` from any function/EXECUTE context —
 * the guard condition works, but the EXECUTE that follows always throws
 * "DROP INDEX CONCURRENTLY cannot be executed from a function". The validity
 * probe runs as a plain application-level SELECT instead, and the DROP (when
 * needed) runs as its own top-level `runMigration` call.
 */
export async function dropInvalidConcurrentIndex(
  engine: BrainEngine,
  version: number,
  indexName: string,
): Promise<boolean> {
  // to_regclass() resolves the unqualified name through search_path — the same
  // resolution the unqualified DROP below relies on — instead of matching
  // pg_class.relname bare, which could hit a same-named index in a different
  // schema on a non-default search_path (codex review, #1178).
  const rows = await engine.executeRaw<{ invalid: boolean }>(
    `SELECT NOT i.indisvalid AS invalid
       FROM pg_index i
      WHERE i.indexrelid = to_regclass($1)`,
    [indexName],
  );
  const isInvalid = rows.some((r) => r.invalid);
  if (isInvalid) {
    await engine.runMigration(version, `DROP INDEX CONCURRENTLY IF EXISTS ${indexName};`);
  }
  return isInvalid;
}
