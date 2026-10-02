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

export type OnlineIndexOutcome = 'present' | 'created' | 'rebuilt' | 'building';

/**
 * #5762: build one index without blocking writers. PGLite runs the plain
 * `CREATE INDEX IF NOT EXISTS`. Postgres leaves a valid index alone, reports
 * one another session is still building, drops an INVALID leftover of an
 * interrupted concurrent build, then runs `CREATE INDEX CONCURRENTLY IF NOT
 * EXISTS` on a dedicated connection under the session's startup timeouts, then
 * confirms the index is valid. Callers build one index at a time;
 * a lock timeout leaves an INVALID index that the next call drops and rebuilds.
 */
export async function buildIndexOnline(
  engine: BrainEngine,
  version: number,
  index: { name: string; table: string; sql: string },
  opts: { notice?: (line: string) => void } = {},
): Promise<OnlineIndexOutcome> {
  if (engine.kind !== 'postgres') {
    const [row] = await engine.executeRaw<{ present: boolean }>('SELECT to_regclass($1) IS NOT NULL AS present', [index.name]);
    if (row?.present) return 'present';
    await engine.runMigration(version, index.sql);
    return 'created';
  }
  const [row] = await engine.executeRaw<{ valid: boolean; building: boolean }>(
    `SELECT i.indisvalid AS valid, EXISTS (SELECT 1 FROM pg_stat_progress_create_index p
        WHERE p.relid=i.indrelid AND p.index_relid IN (i.indexrelid, 0)) AS building
       FROM pg_index i WHERE i.indexrelid = to_regclass($1)`,
    [index.name],
  );
  if (row?.valid) return 'present';
  if (row?.building) return 'building';
  if (row) await dropInvalidConcurrentIndex(engine, version, index.name);
  const [size] = await engine.executeRaw<{ rows: number }>(
    'SELECT GREATEST(reltuples, 0)::bigint AS rows FROM pg_class WHERE oid = to_regclass($1)', [index.table]);
  opts.notice?.(`  building ${index.name} on ~${Number(size?.rows ?? 0)} rows; this can take minutes; it is safe to leave running; `
    + 'if interrupted, gbrain doctor names the rebuild command\n');
  // No session SET: a reservation can fall back to a transaction-pooled connection, where a SET or RESET
  // reaches another client's backend. The build runs under the session's startup timeouts; one that times
  // out leaves an INVALID index, which the next call drops and rebuilds.
  await engine.withReservedConnection(conn => conn.executeRaw(index.sql.replace('CREATE INDEX', 'CREATE INDEX CONCURRENTLY')));
  // IF NOT EXISTS also skips an INVALID index a concurrent caller's failed build left behind.
  const [built] = await engine.executeRaw<{ valid: boolean }>('SELECT indisvalid AS valid FROM pg_index WHERE indexrelid = to_regclass($1)', [index.name]);
  if (!built?.valid) throw new Error(`Index ${index.name} is not valid after its concurrent build; rerun: gbrain repair request-indexes --apply`);
  return row ? 'rebuilt' : 'created';
}
