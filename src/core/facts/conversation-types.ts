/**
 * Canonical allowlist of `pages.type` values the conversation-facts
 * extraction pipeline operates on: conversation, meeting, slack, email,
 * imessage, imessage-daily.
 *
 * Lives in `src/core/facts/` (not `src/commands/`) so a consumer that only
 * needs these six values — doctor.ts's backlog-check default and its
 * conversation_format_coverage sample scan, jobs.ts's extract-conversation-
 * facts Minion job handler, sources.ts's facts-backfill audit estimator —
 * can import just this leaf instead of pulling in
 * `src/commands/extract-conversation-facts.ts`'s own CLI flag surface (that
 * command's help text and its own command-line option parsing).
 *
 * That's not a hypothetical: this file exists BECAUSE `scripts/generate-
 * flag-registry.ts` scans every command-line-option-shaped string literal in
 * a module it finds via a relative import, one level deep. Importing the
 * constant straight from extract-conversation-facts.ts (even just for this
 * constant) transitively attributed that whole option surface to doctor,
 * jobs, and sources — three commands that don't otherwise accept those
 * options — in the generated CLI_ONLY registry (#4135).
 *
 * `src/commands/extract-conversation-facts.ts` imports from here and
 * re-exports both names verbatim so its remaining existing importers (its
 * own tests) keep working unchanged; the cycle backfill phase
 * (`src/core/cycle/conversation-facts-backfill.ts`) imports this leaf
 * directly and is part of the drift-guarded set.
 */
export const ALLOWED_TYPES = Object.freeze([
  'conversation',
  'meeting',
  'slack',
  'email',
  'imessage',
  'imessage-daily',
] as const);

export type AllowedType = (typeof ALLOWED_TYPES)[number];
