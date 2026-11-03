import type { Migration } from './types.ts';
import { GIT_CANONICAL_COUNT_FUNCTION_SQL } from '../persistence/git-canonical-schema.ts';
import { MANAGED_WRITER_GUARD_FUNCTION_SQL } from '../persistence/writer-guard-schema.ts';
import {
  EFFECT_PROTOCOL_GUARD_SQL, PROTOCOL_ACTIVATION_GUARD_SQL, REQUEST_PROTOCOL_GUARD_SQL,
} from '../shared-skills/persistence-schema.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// #7636: the writer-protocol fences read singleton state (persistence_brain,
// git_canonical_brain) and the sources, pages and persistence tables as the
// writing role. A role that neither owns those tables nor bypasses RLS, with
// write policies on a guarded table but none on the lookup, read zero rows and
// the fence treated that as "unmanaged" or "quiesced". Init always writes both
// singleton rows, so a missing one now raises writer_coordinator_required
// (unreadable state), as does a page or source lookup row-level security
// hides, the git-canonical recount under RLS on sources, and protocol
// activation while RLS filters the tables it must see empty. An unmanaged
// brain, the owner and any role that can read the state behave as before,
// except that activation and the recount refuse any caller RLS applies to,
// whatever its policies: a hidden row cannot be told from an absent one there.
// Replaces only the five functions: their triggers already call them, and
// re-creating the triggers would take ACCESS EXCLUSIVE locks on the largest
// tables. No privilege changes, no SECURITY DEFINER, no row is read or written.
export const v278: Migration = {
  version: 278,
  name: 'writer_fence_fail_closed',
  idempotent: true,
  sql: [MANAGED_WRITER_GUARD_FUNCTION_SQL, GIT_CANONICAL_COUNT_FUNCTION_SQL, REQUEST_PROTOCOL_GUARD_SQL,
    EFFECT_PROTOCOL_GUARD_SQL, PROTOCOL_ACTIVATION_GUARD_SQL].map(sql => `${sql.trim().replace(/;$/, '')};`).join('\n'),
};
