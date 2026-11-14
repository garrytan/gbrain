import type { Migration } from './types.ts';
import { GUEST_NOTES_SCHEMA_SQL } from '../guests/schema.ts';
import { GUEST_AWARE_STAMP_TIER_FUNCTION } from '../trust/schema.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// GBRA-504 (guest notes, slice 1): guest_sources (which sources are guest
// sources, their writer list and tier ceiling), guest_marks (who a guest page
// was saved for, immutable, leaves with its page) and guest_promotions, with
// RLS on (v275's list is frozen); the guard that keeps a guest source
// database-only; and the trust trigger function re-created with the guest rules
// (trust/schema.ts): a guest page never rises above its source's ceiling, only a
// listed writer creates or rewrites one, and facts, takes and timeline rows are
// refused there. Function replacement only on the trust tables, so no trigger is
// re-created on them. Additive: no row is read, copied or rewritten, and with no
// guest source every new branch is a no-op, so a repo-less brain gets it
// unchanged. No schema.sql mirror: like v282-v310, it exists only through
// migrations. Provisional number: renumbered at the merge slot.
export const v312: Migration = {
  version: 312,
  name: 'guest_notes',
  idempotent: true,
  sql: `${GUEST_NOTES_SCHEMA_SQL}${GUEST_AWARE_STAMP_TIER_FUNCTION};
`,
};
