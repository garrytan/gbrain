import type { BrainEngine } from '../engine.ts';
import type { Migration } from './types.ts';
import { buildIndexOnline, migrationNotice, runMigrationStatement } from './helpers.ts';
import { PAGES_NAME_LOOKUP_INDEXES } from './v240-pages-name-lookup-indexes.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// #9779: v240 first indexed the exact-title lookups with a btree on
// (source_id, lower(title)). A btree entry must fit in 2,704 bytes, so on a
// brain past v240 a page whose title is longer could not be saved, and the
// index could not be built on a brain that already held one. v240 now builds
// a hash index on lower(title), which stores only the title's hash; the
// lookups compare lower(title) exactly as before, so they use it unchanged.
// schema.sql leaves it out: it replays on every boot, where a plain CREATE
// INDEX would block page writes. This replaces the btree on brains that built it:
// the hash index is built first (CONCURRENTLY on Postgres), so the lookups
// stay indexed throughout, then the btree is dropped CONCURRENTLY (PGLite
// runs the same statement). The btree is dropped only once the hash index is
// valid: when another session is still building it, v326 fails instead of
// recording itself applied, so the next upgrade retries the drop. Each step is
// a no-op once done, so a rerun after an interruption picks up where it stopped. An older gbrain runs against the new index
// unchanged, since its queries are the same.
export const LEGACY_TITLE_BTREE_INDEX = 'idx_pages_source_title_lower';

async function buildHashIndex(engine: BrainEngine): Promise<void> {
  const built = await buildIndexOnline(engine, 326, PAGES_NAME_LOOKUP_INDEXES[0], { notice: migrationNotice });
  if (built === 'building') throw new Error(`${PAGES_NAME_LOOKUP_INDEXES[0].name} is being built by another session; rerun the migration once it finishes`);
}

export const v326: Migration = {
  version: 326,
  name: 'pages_title_lower_hash_index',
  idempotent: true,
  transaction: false,
  sql: '',
  handler: async engine => {
    await buildHashIndex(engine);
    await runMigrationStatement(engine, 326, `DROP INDEX CONCURRENTLY IF EXISTS ${LEGACY_TITLE_BTREE_INDEX}`);
  },
};
