import { SLUG_WORD_CHARS } from './cjk.ts';

/**
 * Op-boundary page-slug segment (#4665/#5032): cjk.ts's PAGE_SLUG_SEG shape
 * widened LOCALLY so `.` and `_` are allowed as part-CONTINUATION characters.
 * Colon separates individually valid parts inside a path segment, preserving
 * existing integration slugs such as `calendar:event-id` without admitting
 * empty or dot-led parts (`calendar:../x` remains invalid). The
 * sync slugifier deliberately preserves both (`notes/v1.0.0`,
 * `people/my_file_name` — see slugifySegment in src/core/sync.ts), so the
 * put_page boundary must round-trip every slug sync can produce. The lead
 * char stays a word char, so dot-LED segments remain impossible — `..`
 * traversal and every H5 rejection (backslash, %2e/%2f encodings, control
 * chars, RTL overrides, spaces) still fail. Deliberately NOT widened in
 * cjk.ts: cite-render, SlugRegistry's SLUG_RE, and the dream-cycle
 * SUMMARY_SLUG_RE consume the shared grammar with different semantics.
 * Compose with the `u` flag — see SLUG_WORD_CHARS.
 */
// Underscore may also LEAD a segment: the sync slugifier preserves leading
// underscores (`_index.md` → `_index`, the Hugo convention), so rejecting
// them recreates the un-updatable-synced-page class this widen closes.
// Dot stays continuation-only — `..` traversal remains impossible.
const OP_PAGE_SLUG_PART = `[${SLUG_WORD_CHARS}_][${SLUG_WORD_CHARS}._\\-]*`;
const OP_PAGE_SLUG_SEG = `${OP_PAGE_SLUG_PART}(?::${OP_PAGE_SLUG_PART})*`;
export const OP_PAGE_SLUG_RE = new RegExp(`^${OP_PAGE_SLUG_SEG}(\\/${OP_PAGE_SLUG_SEG})*$`, 'iu');

/** True when `slug` passes validatePageSlug's op-boundary grammar. */
export function isOpPageSlug(slug: string): boolean {
  return typeof slug === 'string' && slug.length > 0 && slug.length <= 255 && OP_PAGE_SLUG_RE.test(slug);
}
