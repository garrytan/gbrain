import type { Migration } from './types.ts';
import { PERSISTENCE_GIT_DURABILITY_COLUMN_SQL } from '../persistence/schema.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// #5182 per-host Git-durability opt-in for managed worktrees. The column is
// nullable with no default, so Postgres adds it as a catalog-only change (no
// row rewrite, no table scan). The ALTER lives only here and in CREATE TABLE
// (src/core/persistence/schema.ts), never in the replayed schema blob, so an
// existing brain takes the lock exactly once. Postgres bounds the wait so a
// busy writer makes the migration fail fast and retry instead of queueing
// behind it; PGLite has no concurrent writers and PgBouncer transaction mode
// sees SET LOCAL inside the migration's own transaction.
export const v232: Migration = {
  version: 232,
  name: 'persistence_git_durability',
  idempotent: true,
  sql: PERSISTENCE_GIT_DURABILITY_COLUMN_SQL,
  sqlFor: { postgres: `SET LOCAL statement_timeout = '30s'; SET LOCAL lock_timeout = '2s';\n      ${PERSISTENCE_GIT_DURABILITY_COLUMN_SQL}` },
  verify: async (engine) => {
    const rows = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_name='persistence_host_bindings' AND column_name='git_durability'`);
    return Number(rows[0]?.n ?? 0) === 1;
  },
};
