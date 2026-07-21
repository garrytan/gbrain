/**
 * Page lifecycle marker: an author-set frontmatter signal that RETIRES a page
 * from search without deleting it.
 *
 * Why this exists (the gap it closes):
 *   gbrain already models supersession richly at the *facts / takes* layer
 *   (auto-supersession, `valid_until`, `forgotten`). But a raw markdown *page*
 *   had no author-facing way to say "this is out of date — stop surfacing it."
 *   `deleted_at` (soft-delete) hides a page entirely and is an operator action;
 *   `quarantine` is reserved for auto-detected junk. Neither fits the common
 *   authoring case: "I wrote a newer page; keep the old one reachable by slug
 *   for history, but don't let search return it as if it were current."
 *
 * The design mirrors `quarantine` (HIDES) vs `content_flag` (WARNS):
 *   - A page whose frontmatter `status` is one of `LIFECYCLE_HIDE_VALUES`
 *     (`superseded`, `deprecated`, `retired`, `obsolete`) is EXCLUDED from
 *     keyword/vector search via `LIFECYCLE_FILTER_FRAGMENT`, injected by
 *     `buildVisibilityClause` (`src/core/search/sql-ranking.ts`).
 *   - The page is NOT deleted: it stays fetchable by slug (`get_page`), stays
 *     in `list`, and its links/backlinks resolve. `buildVisibilityClause` is a
 *     SEARCH-path filter only, so retirement means "not surfaced by search",
 *     exactly like a page moved to a `cold-storage/` shelf — but driven by a
 *     one-line frontmatter edit instead of a file move.
 *
 * Backward-compatible by construction: only the explicit hide values retire a
 * page. Every other `status` value an author already uses — `active`, `draft`,
 * `done`, `in-progress`, `review`, … — is inert and stays fully searchable.
 * Pages with no `status` key are unaffected.
 *
 * Sibling of `src/core/quarantine.ts` and `src/core/embed-skip.ts` — same
 * marker-as-frontmatter-JSONB pattern, same JSONB access that works identically
 * on Postgres (real) and PGLite (PostgreSQL 17.5 in WASM). NO schema migration:
 * `status` is read straight out of the existing `frontmatter` JSONB column.
 *
 * Follow-up (mirrors quarantine's `content_flag`): a WARN tier — e.g.
 * `status: stale` — that keeps a page searchable but rides a marker into
 * `SearchResult` so the agent is told "this may be dated." Deliberately not in
 * this first cut; there is NO SQL filter for the WARN tier by design.
 */

// ---------------------------------------------------------------------------
// lifecycle marker (RETIRES / hides from search)
// ---------------------------------------------------------------------------

/** Frontmatter key inspected for the retire signal. Stable contract.
 *  Chosen as the plain `status` field authors already reach for, rather than a
 *  namespaced key, because only the explicit hide values below trigger — so
 *  co-opting `status` cannot hide a page that means `status: active`. */
export const LIFECYCLE_KEY = 'status';

/** The `status` values that HIDE a page from search. Lower-cased, trimmed
 *  comparison. Kept deliberately tight and unambiguous — each reads as "this
 *  page is no longer the current answer." `archived` is intentionally excluded
 *  to avoid confusion with the source-level archive flag; add it here (single
 *  change site) if a workspace wants page-frontmatter `status: archived` to
 *  retire too. */
export const LIFECYCLE_HIDE_VALUES: readonly string[] = [
  'superseded',
  'deprecated',
  'retired',
  'obsolete',
] as const;

/** SQL string list for the hide values, single-quoted + lower-cased. All
 *  members are hardcoded constants (never user input), so plain quoting is
 *  injection-safe. */
const HIDE_VALUES_SQL = LIFECYCLE_HIDE_VALUES.map((v) => `'${v}'`).join(', ');

/** SQL fragment that excludes retired pages from search, parameterized on the
 *  page-table alias. Single source of truth — `buildVisibilityClause`
 *  (`src/core/search/sql-ranking.ts`) calls this so the search filter and the
 *  marker vocabulary can never drift. Mirrors `quarantineFilterFragment`:
 *  negated so we KEEP rows that are NOT retired. Rows with no `status`, or a
 *  `status` outside the hide set, coalesce to a non-matching value and survive.
 *  `pageAlias` is engine-supplied (never user input), so no escaping needed. */
export function lifecycleFilterFragment(pageAlias: string): string {
  return (
    `NOT (lower(trim(COALESCE(${pageAlias}.frontmatter ->> '${LIFECYCLE_KEY}', ''))) ` +
    `IN (${HIDE_VALUES_SQL}))`
  );
}

/** The `p`-aliased instance — the common case (all search call sites alias
 *  pages as `p`). Kept as a constant for parity with `QUARANTINE_FILTER_FRAGMENT`. */
export const LIFECYCLE_FILTER_FRAGMENT = lifecycleFilterFragment('p');

/** Normalize a raw frontmatter `status` value the way the SQL does
 *  (string-coerce, trim, lower-case). Non-string values (objects/arrays/numbers)
 *  coerce to a value that will not be in the hide set. */
function normalizeStatus(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase();
}

/** JS-side predicate mirroring the SQL fragment. True when the frontmatter
 *  `status` is one of the hide values. Accepts null/undefined frontmatter. */
export function isRetired(frontmatter: Record<string, unknown> | null | undefined): boolean {
  if (!frontmatter) return false;
  return (LIFECYCLE_HIDE_VALUES as readonly string[]).includes(
    normalizeStatus(frontmatter[LIFECYCLE_KEY]),
  );
}

/** Diagnostic accessor: the matched hide value (already normalized) when the
 *  page is retired, else null. Useful for operator/doctor reporting. */
export function retiredStatus(
  frontmatter: Record<string, unknown> | null | undefined,
): string | null {
  if (!frontmatter) return null;
  const status = normalizeStatus(frontmatter[LIFECYCLE_KEY]);
  return (LIFECYCLE_HIDE_VALUES as readonly string[]).includes(status) ? status : null;
}

/** JS-side filter: returns a new array with retired pages excluded. Parity with
 *  `filterOutQuarantined` for any post-fusion / non-SQL path that needs it. */
export function filterOutRetired<T extends { frontmatter?: Record<string, unknown> | null }>(
  pages: ReadonlyArray<T>,
): T[] {
  return pages.filter((p) => !isRetired(p.frontmatter ?? null));
}
