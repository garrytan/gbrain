import type { Migration } from './types.ts';
import { GUEST_RECORDS_GUARD_FUNCTION } from '../guests/schema.ts';
import { GUEST_FAIL_CLOSED_STAMP_TIER_FUNCTION } from '../trust/schema.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// Follow-ups 3 and 5 of #9354 (guest notes):
//   - The trust trigger's guest guard and the guest-record guard read
//     guest_sources as the writing role. A role that row-level security keeps
//     from reading it (no permissive SELECT policy, not the owner, no BYPASSRLS)
//     read it empty, so a write into a guest source passed as if the source were
//     ordinary. Both functions now refuse such a role with
//     writer_coordinator_required (unreadable_state, state guest_sources), the
//     v281 maintainer refusal. Function replacement only: their triggers already
//     call them. The owner, a role that bypasses RLS and PGLite never reach the
//     policy lookup, so they behave as before.
//   - A unique index on the promotion link (guest page, target source, target
//     slug). A brain that already holds duplicate links keeps them and gets no
//     index (a warning names the table); nothing is rewritten on upgrade, and
//     promotion still writes at most one link per target.
// No schema.sql mirror, like v312.
export const v314: Migration = {
  version: 314,
  name: 'guest_notes_fail_closed',
  idempotent: true,
  sql: `${GUEST_RECORDS_GUARD_FUNCTION};
${GUEST_FAIL_CLOSED_STAMP_TIER_FUNCTION};
DO $idx$ BEGIN
  IF EXISTS (SELECT 1 FROM guest_promotions GROUP BY guest_page_id, target_source_id, target_slug HAVING count(*) > 1) THEN
    RAISE WARNING 'guest_promotions holds duplicate promotion links; the unique index guest_promotions_link_key was not created';
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS guest_promotions_link_key ON guest_promotions (guest_page_id, target_source_id, target_slug);
  END IF;
END $idx$;
`,
};
