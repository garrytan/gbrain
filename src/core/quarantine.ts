/**
 * Quarantine + content-flag markers: the two frontmatter markers the
 * content-quality gate writes (issue #1699).
 *
 * Why two markers, not one (Q1=A confidence split):
 *   - `quarantine` HIDES. Set ONLY for high-confidence junk (Cloudflare /
 *     CAPTCHA interstitial patterns + operator literals). The page lands
 *     (reviewable via get_page / quarantine list) but writes zero chunks
 *     and is excluded from search via `QUARANTINE_FILTER_FRAGMENT`.
 *   - `content_flag` WARNS, does NOT hide. Set for the fuzzy markup-ratio
 *     signal and for oversize. The page stays fully searchable; the marker
 *     rides along so search results / get_page can tell the agent "this
 *     looks like boilerplate / is unusually large — examine it." There is
 *     NO SQL filter fragment for content_flag, by design.
 *
 * Three distinct markers, three reasons (Codex #6 — never overload one to
 * mean another):
 *   - `embed_skip`   (src/core/embed-skip.ts) = "oversized-but-clean, not embedded"
 *   - `quarantine`   (here)                   = "junk, hidden from search"
 *   - `content_flag` (here)                   = "odd, examine, still here"
 * A page can carry more than one (oversize → embed_skip + content_flag:oversized);
 * each is cleared independently.
 *
 * Sibling of `src/core/embed-skip.ts` — same marker-as-JSONB-object pattern,
 * same JSONB `?` existence check that works identically on Postgres (real)
 * and PGLite (PostgreSQL 17.5 in WASM). No schema migration (D4): both are
 * frontmatter JSONB keys.
 *
 * v0.42 follow-up: promote `quarantine` to a schema column +
 * partial index if the quarantined subset grows large. Single change
 * site (this module).
 */

// ---------------------------------------------------------------------------
// quarantine marker (HIDES)
// ---------------------------------------------------------------------------

/** Frontmatter key for the HIDE marker. Stable contract. */
export const QUARANTINE_KEY = 'quarantine';

/** SQL fragment that excludes quarantined pages from search, parameterized on
 *  the page-table alias. Single source of truth — `buildVisibilityClause`
 *  (`src/core/search/sql-ranking.ts`) calls this so the search filter and the
 *  marker key can never drift. Mirrors `EMBED_SKIP_FILTER_FRAGMENT` shape:
 *  JSONB `?` existence, negated so we KEEP rows WITHOUT the marker.
 *  `pageAlias` is engine-supplied (never user input), so no escaping needed. */
export function quarantineFilterFragment(pageAlias: string): string {
  return `NOT (COALESCE(${pageAlias}.frontmatter, '{}'::jsonb) ? '${QUARANTINE_KEY}')`;
}

/** The `p`-aliased instance — the common case (all 6 search call sites alias
 *  pages as `p`). Kept as a constant for parity with `EMBED_SKIP_FILTER_FRAGMENT`
 *  and for any future stale/orphan-chunk query that needs it. */
export const QUARANTINE_FILTER_FRAGMENT = quarantineFilterFragment('p');

export interface QuarantineMarker {
  /** Why the page was quarantined. The high-confidence junk reasons. */
  reason: 'junk_pattern' | 'literal_substring';
  /** Human-readable detail (which pattern/literal names fired). */
  detail: string;
  /** ISO 8601 timestamp at assessment time. */
  assessed_at: string;
  /** Body bytes at assessment, for operator visibility. */
  bytes?: number;
}

/** Build the canonical quarantine marker. Spread onto frontmatter before
 *  write: `frontmatter[QUARANTINE_KEY] = buildQuarantineMarker(...)`. */
export function buildQuarantineMarker(
  reason: QuarantineMarker['reason'],
  detail: string,
  extra: { bytes?: number; now?: Date } = {},
): QuarantineMarker {
  return {
    reason,
    detail,
    assessed_at: (extra.now ?? new Date()).toISOString(),
    ...(extra.bytes !== undefined ? { bytes: extra.bytes } : {}),
  };
}

/** JS-side predicate. True when the frontmatter has the quarantine key set
 *  to any non-null value. Accepts null/undefined frontmatter. Key-existence
 *  is the trigger; marker contents are diagnostic (mirrors the SQL fragment). */
export function isQuarantined(frontmatter: Record<string, unknown> | null | undefined): boolean {
  if (!frontmatter) return false;
  const value = frontmatter[QUARANTINE_KEY];
  return value !== undefined && value !== null;
}

/** JS-side filter: returns a new array with quarantined pages excluded. */
export function filterOutQuarantined<T extends { frontmatter?: Record<string, unknown> | null }>(
  pages: ReadonlyArray<T>,
): T[] {
  return pages.filter((p) => !isQuarantined(p.frontmatter ?? null));
}

// ---------------------------------------------------------------------------
// content_flag marker (WARNS, does NOT hide)
// ---------------------------------------------------------------------------

/** Frontmatter key for the WARN marker. Stable contract. */
export const CONTENT_FLAG_KEY = 'content_flag';

export interface ContentFlagMarker {
  /** Which fuzzy/oversize tier fired. */
  reason: 'markup_heavy' | 'oversized';
  /** Human-readable detail surfaced to the agent on retrieval. */
  detail: string;
  /** ISO 8601 timestamp at assessment time. */
  assessed_at: string;
  /** Markup ratio (when reason is markup_heavy). */
  markup_ratio?: number;
  /** Body bytes (when reason is oversized). */
  bytes?: number;
}

/** Build the canonical content-flag marker. NOTE: there is deliberately NO
 *  SQL filter fragment for content_flag — flagged pages stay searchable; the
 *  marker is READ INTO search/get_page output, never used to exclude. */
export function buildContentFlagMarker(
  reason: ContentFlagMarker['reason'],
  detail: string,
  extra: { markup_ratio?: number; bytes?: number; now?: Date } = {},
): ContentFlagMarker {
  return {
    reason,
    detail,
    assessed_at: (extra.now ?? new Date()).toISOString(),
    ...(extra.markup_ratio !== undefined ? { markup_ratio: extra.markup_ratio } : {}),
    ...(extra.bytes !== undefined ? { bytes: extra.bytes } : {}),
  };
}

/** Read the content-flag marker from frontmatter, or null. The shape is
 *  validated loosely — a `reason` string is the minimum contract. Used by
 *  the search projection + get_page to populate the agent-warning channel. */
export function getContentFlag(
  frontmatter: Record<string, unknown> | null | undefined,
): { reason: string; detail: string } | null {
  if (!frontmatter) return null;
  const value = frontmatter[CONTENT_FLAG_KEY];
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  const reason = typeof obj.reason === 'string' ? obj.reason : null;
  if (!reason) return null;
  return { reason, detail: typeof obj.detail === 'string' ? obj.detail : '' };
}

/** True when the frontmatter carries a content-flag marker. */
export function hasContentFlag(frontmatter: Record<string, unknown> | null | undefined): boolean {
  return getContentFlag(frontmatter) !== null;
}
