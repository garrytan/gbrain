import type { Migration } from './types.ts';
import { GIT_FIRST_SCHEMA_SQL, INDEX_EFFECT_BARRIER_SQL } from '../persistence/git-first-schema.ts';
import { runMigrationStatement } from './helpers.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// Wave C 1H (large-pages spec §2.7, §3.1 step 8, §17 ceo-r3-native-2): the git-first strict write path.
// - page_pending_heads, page_upload_spools and page_upload_spool_parts (git-first-schema.ts; also in both blobs).
// - pages.indexed_commit: the commit the live generation was indexed from. NULL means indexed before Wave C;
//   nothing is backfilled. Migration-only, like v274, so fresh and upgraded brains share pages column ordinals.
// - persistence_requests.state takes 'indexing' (request-states.ts): Git holds the write and the database has not
//   derived it yet. The constraint is replaced NOT VALID and validated in its own statement, so no scan of the
//   journal runs under the ALTER's lock.
// - persistence_effects_index_barrier (git-first-schema.ts INDEX_EFFECT_BARRIER_SQL): an index-split-page effect keeps
//   next_attempt_at at 'infinity', so a released binary's claim never selects it (eng-r3-outside-4).
// Additive: no row is read or rewritten. Provisional number: renumbered at the merge slot.
export const v278: Migration = {
  version: 278,
  name: 'git_first_strict_path',
  idempotent: true,
  transaction: false,
  sql: `
    ${GIT_FIRST_SCHEMA_SQL}
    ${INDEX_EFFECT_BARRIER_SQL}
    ALTER TABLE pages ADD COLUMN IF NOT EXISTS indexed_commit TEXT;
    DO $do$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'persistence_requests_state_check' AND conrelid = 'persistence_requests'::regclass
          AND pg_get_constraintdef(oid) LIKE '%indexing%') THEN
        ALTER TABLE persistence_requests DROP CONSTRAINT IF EXISTS persistence_requests_state_check;
        ALTER TABLE persistence_requests ADD CONSTRAINT persistence_requests_state_check
          CHECK (state IN ('queued','running','recovering','indexing','committed','conflict','failed','cancelled')) NOT VALID;
      END IF;
    END $do$;
  `,
  handler: async engine => {
    await runMigrationStatement(engine, 278, 'ALTER TABLE persistence_requests VALIDATE CONSTRAINT persistence_requests_state_check;');
  },
};
