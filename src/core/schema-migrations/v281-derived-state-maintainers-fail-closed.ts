import type { Migration } from './types.ts';
import { CLEAR_ATOM_PAGE_STATE_FUNCTION_SQL, PAGE_RETRIEVALS_FORGET_FUNCTION_SQL } from '../derived-state-maintainers.ts';
import { BUMP_FUNCTION } from '../eligibility/generation-schema.ts';
import { getFtsLanguage, pageSearchVectorTriggerFnSql } from '../fts-language.ts';
import { PAGE_PROJECTION_QUEUE_FUNCTION_SQL } from '../page-state/projection-schema.ts';
import { TAG_REVISION_FUNCTION_SQL } from '../page-state/schema.ts';
import { STAMP_VERSION_FUNCTION } from '../persistence/attribution-schema.ts';
import { SNAPSHOT_VERSION_FUNCTION } from '../trust/schema.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// #7637: the derived-state maintainer triggers read and write tables other
// than the one being written, as the writing role. A role that neither owns
// those tables nor bypasses RLS, with write policies on the written table but
// none on the maintainer's, read them empty: a deleted page kept its
// page_retrievals rows, a soft-deleted page its atom scan state, a tag write
// left the page revision alone, a version row got NULL trust and attribution
// and a retitled page lost its timeline entries from search; the projection
// queue and the trust generation failed with a raw RLS error. Each maintainer
// now refuses with writer_coordinator_required (unreadable_state, as v278 does)
// when RLS applies to the caller on a table it needs and no permissive policy
// of the caller covers a command it runs there (derived-state-maintainers.ts).
// The owner, a role that bypasses RLS and a role holding those policies behave
// as before. Replaces only the eight functions: their triggers already call
// them, and re-creating the triggers would take ACCESS EXCLUSIVE locks on the
// largest tables. No SECURITY DEFINER (#7659), no privilege change, no row is
// read or written. The page search vector function takes the configured FTS
// language, so it is created by the handler (getFtsLanguage() validates it).
export const v281: Migration = {
  version: 281,
  name: 'derived_state_maintainers_fail_closed',
  idempotent: true,
  sql: [PAGE_RETRIEVALS_FORGET_FUNCTION_SQL, CLEAR_ATOM_PAGE_STATE_FUNCTION_SQL, TAG_REVISION_FUNCTION_SQL, SNAPSHOT_VERSION_FUNCTION,
    STAMP_VERSION_FUNCTION, PAGE_PROJECTION_QUEUE_FUNCTION_SQL, BUMP_FUNCTION].map(sql => `${sql.trim().replace(/;$/, '')};`).join('\n'),
  handler: async engine => { await engine.executeRaw(pageSearchVectorTriggerFnSql(getFtsLanguage())); },
};
