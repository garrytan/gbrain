/**
 * v0.31.2 — facts backstop eligibility predicate.
 *
 * Single source of truth for "should this page write fire the facts
 * extraction backstop?" Used by:
 *   - put_page (operations.ts:556 — MCP backstop hook)
 *   - sync.ts post-import hook
 *   - file_upload + code_import callers
 *   - extract_facts MCP op (negative path: returns 'eligibility_failed' so
 *     the caller sees a stable reason)
 *
 * Pre-extraction (PR1 commit 5), this lived inline at operations.ts:633
 * and sync.ts had its own divergent type filter (`['conversation',
 * 'transcript', 'personal', 'therapy', 'call']` — only `meeting` was a
 * real PageType, the rest never matched). Sync's filter is deleted in
 * commit 7; everyone routes through this predicate.
 *
 * Eligible:
 *   - parsed is non-null
 *   - slug does NOT start with `wiki/agents/` (subagent scratch is its
 *     own world; not user-meaningful for hot memory)
 *   - frontmatter.dream_generated is NOT `true` (anti-loop: never extract
 *     from dream-generated pages — they're already a digest)
 *   - body length >= 80 chars (skip TODO-style snippets)
 *   - parsed.type ∈ {note, meeting, slack, email, calendar-event, source, writing}
 *     OR slug.startsWith('meetings/' | 'personal/' | 'daily/')
 *     (the slug-prefix branch is a "rescue" — a meetings/2026-05-09-foo.md
 *      page that frontmatter-typed itself as 'note' should still get facts
 *      extracted; the directory says it's a meeting regardless of the
 *      legacy frontmatter type. Test fixtures cover all four combinations.)
 *
 * Reasons returned for the skipped envelope are stable strings consumed
 * by tests and observability (the doctor's facts_extraction_health check
 * groups by reason).
 */

import type { PageType } from '../types.ts';

export type EligibilityResult = { ok: true } | { ok: false; reason: string };

/**
 * Path prefixes that rescue a page even when frontmatter type is not
 * eligible. A `meetings/2026-05-09-foo.md` page typed as 'note' (the
 * legacy default) still extracts because the directory tells us it's
 * conversation-shape.
 */
const RESCUE_SLUG_PREFIXES = ['meetings/', 'personal/', 'daily/'] as const;

const ELIGIBLE_TYPES: PageType[] = [
  'note', 'meeting', 'slack', 'email', 'calendar-event', 'source', 'writing',
];

const MIN_BODY_CHARS = 80;

export function isFactsBackstopEligible(
  slug: string,
  parsed: { type: PageType; compiled_truth: string; frontmatter: Record<string, unknown> } | null | undefined,
): EligibilityResult {
  if (!parsed) return { ok: false, reason: 'no_parsed_page' };
  if (slug.startsWith('wiki/agents/')) return { ok: false, reason: 'subagent_namespace' };
  if (parsed.frontmatter && parsed.frontmatter.dream_generated === true) {
    return { ok: false, reason: 'dream_generated' };
  }

  const body = (parsed.compiled_truth ?? '').trim();
  if (body.length < MIN_BODY_CHARS) return { ok: false, reason: 'too_short' };

  const typeOk = ELIGIBLE_TYPES.includes(parsed.type);
  const slugOk = RESCUE_SLUG_PREFIXES.some(p => slug.startsWith(p));
  if (!typeOk && !slugOk) return { ok: false, reason: `kind:${parsed.type}` };

  return { ok: true };
}
