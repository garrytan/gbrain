/**
 * Linkable-page scope — the single definition of which pages are expected
 * to participate in the link graph.
 *
 * Two consumers MUST agree on this definition or `gbrain doctor` contradicts
 * itself inside one report:
 *
 *   - the orphans audit (`src/commands/orphans.ts`) excludes archive and
 *     generated pages from orphan accounting ("no inbound links is
 *     expected / not a content problem"), and
 *   - brain_score's no-orphans and timeline-coverage components
 *     (`getHealth()` in both engines) previously counted EVERY page.
 *
 * On a brain with a large raw archive the same report read "orphan ratio
 * 19% (linkable pages)" in one check and a no-orphans score implying ~70%
 * orphans two lines later. Same word, two denominators.
 *
 * The JS predicate (`shouldExcludeFromLinkableScope`) and the SQL fragments
 * (`LINKABLE_EXCLUDE_*`) are generated from the same constants so the two
 * evaluation paths cannot drift.
 */

/**
 * Slug suffixes that are always auto-generated root files.
 * `/readme` — a README is a folder descriptor, not a knowledge node;
 * nothing is expected to wikilink to it.
 */
export const AUTO_SUFFIX_PATTERNS = ['/_index', '/log', '/readme'];

/**
 * Page slugs that are pseudo-pages by convention.
 * `readme` / `index` — root-level folder descriptors, same rationale as
 * the `/readme` suffix and the existing `_index` pseudo-page.
 * `schema` — written by the schema pack on init; `log` — the root brain log.
 */
export const PSEUDO_SLUGS = new Set(['_atlas', '_index', '_stats', '_orphans', '_scratch', 'claude', 'readme', 'index', 'schema', 'log']);

/** Slug segment that marks raw sources */
export const RAW_SEGMENT = '/raw/';

/**
 * `raw/` as the FIRST slug segment — the same archive convention as
 * RAW_SEGMENT, previously missed because `includes('/raw/')` requires a
 * leading segment. Brains that keep their archive at the repo root
 * (`raw/whatsapp/...`) had every archive page counted as an orphan.
 */
export const RAW_PREFIX = 'raw/';

/** Slug prefixes where no inbound links is expected */
export const DENY_PREFIXES = [
  'output/',
  'outputs/',
  'dashboards/',
  'scripts/',
  'templates/',
  'openclaw/config/',
];

/**
 * First slug segments where no inbound links is expected.
 *
 * `daily` — daily records (calendar sync, email digests, activity logs —
 * the pages gbrain's own calendar/email integrations write under
 * `daily/...`) link OUT to the graph; nothing is expected to link back to
 * a dated log page.
 *
 * `extracts` — machine-generated takes/extraction pages gbrain's own
 * pipelines write (e.g. `extracts/<date>/takes.proposed/...`); they exist
 * only in the DB and are not curated content.
 */
export const FIRST_SEGMENT_EXCLUSIONS = new Set([
  'scratch',
  'thoughts',
  'catalog',
  'entities',
  'raw',
  'atoms',
  'skills',
  'daily',
  'extracts',
  // 'inbox' — GTD-style intake tray: dated collector records in transit
  // (email digests, alerts) awaiting triage; nothing links INTO an inbox
  // item, same rationale as 'daily'.
  'inbox',
]);

/**
 * Returns true if a slug is excluded from the linkable scope: pages where
 * having no inbound links is expected / not a content problem.
 */
export function shouldExcludeFromLinkableScope(slug: string): boolean {
  // Pseudo-pages (exact match)
  if (PSEUDO_SLUGS.has(slug)) return true;

  // Auto-generated suffix patterns
  for (const suffix of AUTO_SUFFIX_PATTERNS) {
    if (slug.endsWith(suffix)) return true;
  }

  // Raw source slugs (any segment, including leading)
  if (slug.includes(RAW_SEGMENT)) return true;
  if (slug.startsWith(RAW_PREFIX)) return true;

  // Deny-prefix slugs
  for (const prefix of DENY_PREFIXES) {
    if (slug.startsWith(prefix)) return true;
  }

  // First-segment exclusions
  const firstSegment = slug.split('/')[0];
  if (FIRST_SEGMENT_EXCLUSIONS.has(firstSegment)) return true;

  return false;
}

// --- SQL projection of the same predicate ---
//
// getHealth() evaluates the scope inside one SQL statement. These arrays are
// derived from the constants above; a slug is excluded when it matches ANY
// LIKE pattern, equals ANY exact slug, or its first segment equals ANY
// excluded segment:
//
//   slug NOT LIKE ALL($like) AND slug != ALL($exact)
//     AND split_part(slug, '/', 1) != ALL($segments)

/** LIKE patterns — a slug matching any of these is excluded. */
export const LINKABLE_EXCLUDE_LIKE: string[] = [
  `%${RAW_SEGMENT}%`,
  `${RAW_PREFIX}%`,
  ...DENY_PREFIXES.map((p) => `${p}%`),
  ...AUTO_SUFFIX_PATTERNS.map((s) => `%${s}`),
];

/** Exact slugs excluded (pseudo-pages). */
export const LINKABLE_EXCLUDE_EXACT: string[] = [...PSEUDO_SLUGS];

/** First slug segments excluded. */
export const LINKABLE_EXCLUDE_FIRST_SEGMENTS: string[] = [...FIRST_SEGMENT_EXCLUSIONS];
