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
import type { BrainEngine } from '../engine.ts';

export const ALLOWED_TYPES = Object.freeze([
  'conversation',
  'meeting',
  'slack',
  'email',
  'imessage',
  'imessage-daily',
] as const);

export type AllowedType = (typeof ALLOWED_TYPES)[number];

/**
 * Granular collector page-types that alias into each canonical conversation
 * bucket. The v2 type-consolidation pack retypes these to the canonical names
 * (`slack-dm-day`/`slack-thread` → `slack`, `email-digest` → `email`), but a
 * brain that hasn't run that pack still carries the collector's granular types
 * in `pages.type`. Without this expansion, `listPages({ type: 'slack' })`
 * matches zero rows on such brains and the whole comms corpus is silently
 * skipped (facts stay empty → `find_trajectory` returns nothing). The canonical
 * name is always included first so consolidated brains keep working unchanged.
 */
export const ALLOWED_TYPE_ALIASES: Record<AllowedType, readonly string[]> = {
  conversation: ['conversation'],
  meeting: ['meeting'],
  slack: ['slack', 'slack-dm-day', 'slack-thread'],
  email: ['email', 'email-digest'],
  imessage: ['imessage'],
  'imessage-daily': ['imessage-daily'],
};

/**
 * Expand the requested logical types to the concrete `pages.type` values to
 * enumerate, canonical-first and de-duplicated. Unknown types pass through
 * unchanged so an explicit override is never dropped.
 */
export function pageTypesForAllowed(types: readonly AllowedType[]): string[] {
  const out: string[] = [];
  for (const t of types) {
    for (const concrete of ALLOWED_TYPE_ALIASES[t] ?? [t]) {
      if (!out.includes(concrete)) out.push(concrete);
    }
  }
  return out;
}

export const REQUIRE_PARSEABLE_FLAG_CONFIG_KEY = 'cycle.conversation_facts_backfill.require_parseable_flag';

const FLAG_TRUE = ['true', '1', 'yes', 'on'];
const FLAG_FALSE = ['false', '0', 'no', 'off'];
const flagText = (v: unknown): string => (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v).trim().toLowerCase() : '');

/** A frontmatter flag set off: `false`, `0`, `no` or `off`, as a YAML scalar or as text, in any case. */
export const isFrontmatterFlagOff = (v: unknown): boolean => FLAG_FALSE.includes(flagText(v));

/** Strict eligibility (opt-in): only `type: conversation` or an explicit `conversation_parseable: true`. */
export async function requireParseableConversationFlag(engine: Pick<BrainEngine, 'getConfig'>): Promise<boolean> {
  return FLAG_TRUE.includes(flagText(await engine.getConfig(REQUIRE_PARSEABLE_FLAG_CONFIG_KEY)));
}

/**
 * #5330 — the one conversation-facts eligibility rule, shared by the
 * extractor, the doctor backlog and the format-coverage sample. A page of an
 * allowed type is eligible unless its frontmatter says
 * `conversation_parseable: false` (a source-evidence page that shares a
 * conversation type but holds no conversation). In strict mode only
 * `type: conversation` or `conversation_parseable: true` is eligible.
 * `concreteTypes` are `pages.type` values (the extractor's pageTypesForAllowed).
 */
export function isConversationFactsEligiblePage(
  page: { type: string; frontmatter?: Record<string, unknown> | null },
  concreteTypes: readonly string[],
  strict = false,
): boolean {
  if (!concreteTypes.includes(page.type)) return false;
  const marker = flagText(page.frontmatter?.conversation_parseable);
  if (FLAG_FALSE.includes(marker)) return false;
  return !strict || page.type === 'conversation' || FLAG_TRUE.includes(marker);
}

/** SQL twin of isConversationFactsEligiblePage over `alias`; `typesParam` binds the concrete types. */
export function conversationFactsEligibleSql(alias: string, typesParam: string, strict: boolean): string {
  const marker = `LOWER(BTRIM(COALESCE(${alias}.frontmatter->>'conversation_parseable', '')))`;
  const list = (values: string[]) => values.map(v => `'${v}'`).join(', ');
  return `${alias}.type = ANY(${typesParam}::text[]) AND ${marker} NOT IN (${list(FLAG_FALSE)})` +
    (strict ? ` AND (${alias}.type = 'conversation' OR ${marker} IN (${list(FLAG_TRUE)}))` : '');
}
