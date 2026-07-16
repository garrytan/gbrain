/**
 * gbrain orphans — Surface pages with no inbound wikilinks.
 *
 * Deterministic: zero LLM calls. Queries the links table for pages with
 * no entries where to_page_id = pages.id. By default filters out
 * auto-generated pages and pseudo-pages where no inbound links is expected.
 *
 * Usage:
 *   gbrain orphans                  # list orphans grouped by domain
 *   gbrain orphans --json           # JSON output for agent consumption
 *   gbrain orphans --count          # just the number
 *   gbrain orphans --include-pseudo # include auto-generated/pseudo pages
 */

import type { BrainEngine } from '../core/engine.ts';
import { createProgress, startHeartbeat } from '../core/progress.ts';
import { getCliOptions, cliOptsToProgressOptions } from '../core/cli-options.ts';

// --- Types ---

export interface OrphanPage {
  slug: string;
  title: string;
  domain: string;
}

export interface OrphanResult {
  orphans: OrphanPage[];
  total_orphans: number;
  total_linkable: number;
  total_pages: number;
  excluded: number;
}

// --- Filter constants ---

/** Slug suffixes that are always auto-generated root files */
const AUTO_SUFFIX_PATTERNS = ['/_index', '/log'];

/** Page slugs that are pseudo-pages by convention */
const PSEUDO_SLUGS = new Set(['_atlas', '_index', '_stats', '_orphans', '_scratch', 'claude']);

/** Slug segment that marks raw sources */
const RAW_SEGMENT = '/raw/';

/** Slug prefixes where no inbound links is expected */
const DENY_PREFIXES = [
  'output/',
  'dashboards/',
  'scripts/',
  'templates/',
  'openclaw/config/',
];

/** First slug segments where no inbound links is expected */
const FIRST_SEGMENT_EXCLUSIONS = new Set(['scratch', 'thoughts', 'catalog', 'entities']);

/**
 * Page types where no inbound links is expected by design. Shipped
 * defaults that always apply alongside user-configured types from
 * `orphans.exclude_types`:
 *
 *   - `code`: code-symbol extractions from `gbrain extract`. Code files
 *     don't wikilink to code files; orphan reporting on them is
 *     structurally meaningless noise.
 *   - `extract_receipt`: system artifact written by extract phases.
 *     Never authored content.
 *   - `feat` / `fix` / `refactor` / `chore`: commit-summary page types
 *     written by `gstack-memory-ingest` when it lands code-stage
 *     transcripts into the brain. Each row summarizes one commit; the
 *     concept of a "linked" commit summary doesn't exist.
 *
 * Same one-directional contract as DENY_PREFIXES: user config can extend
 * this list, never remove from it. The shipped entries encode page-type
 * shapes that are orphan-by-construction regardless of brain layout.
 */
export const DEFAULT_EXCLUDE_TYPES: readonly string[] = [
  'code',
  'extract_receipt',
  'feat',
  'fix',
  'refactor',
  'chore',
];

/**
 * Brain-level config key for user-specified additional deny prefixes.
 * Value is a comma-separated string of slug prefixes; whitespace around
 * commas is tolerated, empty entries are dropped. Example:
 *
 *   gbrain config set orphans.exclude_prefixes 'resources/,transcripts/,agents/'
 *
 * The shipped `DENY_PREFIXES` constant ABOVE covers gbrain-internal
 * convention dirs (output, scripts, templates, openclaw/config). User
 * brains organized by other conventions (PARA's `resources/` +
 * `archives/`, Obsidian vaults with `clips/`, code corpora with
 * `transcripts/`, etc.) leak hundreds-to-thousands of "orphan" pages
 * that are reference material by design — not authored content meant to
 * be linked. This config knob lets the user extend the deny list without
 * patching source. Empty / unset preserves today's behavior exactly.
 */
export const USER_EXCLUDE_PREFIXES_CONFIG_KEY = 'orphans.exclude_prefixes';

/**
 * Parse a comma-separated config string into a normalized list of slug
 * prefixes. Tolerant of whitespace, drops empties, returns `[]` for any
 * non-string or empty input. Exported for the unit tests that pin the
 * parse semantics independent of the DB roundtrip.
 */
export function parseUserExcludePrefixes(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  return raw.split(',').map(s => s.trim()).filter(s => s.length > 0);
}

/**
 * Read + parse the user-configured deny prefixes from the engine. Returns
 * `[]` when the key is unset OR when the stored value isn't a usable
 * string. Callers pass the result into `shouldExclude` so the
 * config-aware exclusion is additive on top of the shipped defaults.
 */
export async function readUserExcludePrefixes(engine: BrainEngine): Promise<string[]> {
  const raw = await engine.getConfig(USER_EXCLUDE_PREFIXES_CONFIG_KEY);
  return parseUserExcludePrefixes(raw);
}

/**
 * Brain-level config key for user-specified page-type exclusions. Value
 * is a comma-separated string of `pages.type` values; whitespace around
 * commas is tolerated, empty entries are dropped. Example:
 *
 *   gbrain config set orphans.exclude_types 'code'
 *   gbrain config set orphans.exclude_types 'code,extract_receipt'
 *
 * Code-symbol extractions, gstack-memory-ingest commit-summary pages
 * (`feat`, `fix`, `refactor`, `chore`), and system artifacts
 * (`extract_receipt`) are orphan-by-design at the page level. Schema-pack
 * concept pages OR notes-typed pages from the same source can be real
 * orphans worth surfacing — filtering at the source level would erase
 * those too. Page-type filtering catches the structural noise without
 * losing the documentation signal that lives alongside code in the same
 * repos.
 *
 * Strict equality on `pages.type` (no prefix matching, no glob). A user
 * who wants substring or wildcard semantics should run the broader
 * `orphans.exclude_prefixes` knob instead.
 */
export const EXCLUDE_TYPES_CONFIG_KEY = 'orphans.exclude_types';

/**
 * Parse a comma-separated config string into a normalized list of type
 * names. Identical shape to `parseUserExcludePrefixes` — both consume the
 * same CSV format from `gbrain config set`. Returns `[]` for any
 * non-string or empty input.
 */
export function parseExcludeTypes(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  return raw.split(',').map(s => s.trim()).filter(s => s.length > 0);
}

/**
 * Read + parse the user-configured type-exclusion list and merge it with
 * the shipped DEFAULT_EXCLUDE_TYPES. User entries extend the defaults;
 * neither can remove from the other. Returns the deduplicated union.
 * Threaded into `findOrphans` via the engine's `findOrphanPages({
 * excludeTypes })` parameter so the filter applies at the SQL level
 * rather than a post-query loop.
 *
 * Calling pattern: brains that never set the key get the shipped
 * defaults exactly. Brains that set `orphans.exclude_types 'guide'` get
 * the shipped defaults PLUS `guide`. There is no way to disable a
 * shipped default short of patching this list — same one-directional
 * contract as DENY_PREFIXES, for the same reason: shipped entries
 * encode structural orphan-by-construction shapes, not preference.
 */
export async function readExcludeTypes(engine: BrainEngine): Promise<string[]> {
  const raw = await engine.getConfig(EXCLUDE_TYPES_CONFIG_KEY);
  const userTypes = parseExcludeTypes(raw);
  const merged = new Set<string>([...DEFAULT_EXCLUDE_TYPES, ...userTypes]);
  return [...merged];
}

// --- Filter logic ---

/**
 * Returns true if a slug should be excluded from orphan reporting by default.
 * These are pages where having no inbound links is expected / not a content problem.
 *
 * `userPrefixes` (optional, default `[]`) extends `DENY_PREFIXES` with
 * deny prefixes from the brain config (`orphans.exclude_prefixes`). The
 * shipped defaults always apply; user prefixes are additive, not
 * replacing — there's no way for an empty/unset config to undo a shipped
 * default. That's intentional: the defaults capture gbrain-internal
 * conventions (e.g. `output/`, `templates/`) that downstream tooling
 * relies on. User prefixes capture per-brain conventions on top.
 */
export function shouldExclude(slug: string, userPrefixes: string[] = []): boolean {
  // Pseudo-pages (exact match)
  if (PSEUDO_SLUGS.has(slug)) return true;

  // Auto-generated suffix patterns
  for (const suffix of AUTO_SUFFIX_PATTERNS) {
    if (slug.endsWith(suffix)) return true;
  }

  // Raw source slugs
  if (slug.includes(RAW_SEGMENT)) return true;

  // Deny-prefix slugs (shipped defaults)
  for (const prefix of DENY_PREFIXES) {
    if (slug.startsWith(prefix)) return true;
  }

  // Deny-prefix slugs (user-configured additions, additive to defaults).
  // Same startsWith semantics as the shipped list so the user-facing
  // mental model is "extend the deny list, don't replace it".
  for (const prefix of userPrefixes) {
    if (slug.startsWith(prefix)) return true;
  }

  // First-segment exclusions
  const firstSegment = slug.split('/')[0];
  if (FIRST_SEGMENT_EXCLUSIONS.has(firstSegment)) return true;

  return false;
}

/**
 * Derive domain from frontmatter or first slug segment.
 */
export function deriveDomain(frontmatterDomain: string | null | undefined, slug: string): string {
  if (frontmatterDomain && typeof frontmatterDomain === 'string' && frontmatterDomain.trim()) {
    return frontmatterDomain.trim();
  }
  return slug.split('/')[0] || 'root';
}

// --- Core query ---

/**
 * Find pages with no inbound links via the engine's built-in helper.
 * Returns raw rows (all pages regardless of filter).
 *
 * As of v0.17: takes an engine argument. Composes with runCycle which
 * passes an explicit engine. No more db.getConnection() global — fixes
 * the PGLite-vs-Postgres + test-fixture coupling codex flagged.
 */
export async function queryOrphanPages(
  engine: BrainEngine,
): Promise<{ slug: string; title: string; domain: string | null }[]> {
  return engine.findOrphanPages();
}

/**
 * Find orphan pages, with optional pseudo-page filtering.
 * Returns structured OrphanResult with totals.
 *
 * As of v0.17: `engine` is required. See queryOrphanPages for rationale.
 *
 * v0.42.0.0 (D1 from /plan-eng-review): this is the canonical pure data
 * fn for "what counts as an orphan in this brain." Re-exported as
 * `getOrphansData` for the doctor `orphan_ratio` check and any other
 * consumer that needs the same exclusion logic (AUTO_SUFFIX_PATTERNS,
 * PSEUDO_SLUGS, RAW_SEGMENT, DENY_PREFIXES, FIRST_SEGMENT_EXCLUSIONS).
 * Two consumers sharing one definition = doctor and `gbrain orphans`
 * cannot disagree on the orphan count.
 */
export async function findOrphans(
  engine: BrainEngine,
  opts: { includePseudo?: boolean; sourceId?: string; sourceIds?: string[] } = {},
): Promise<OrphanResult> {
  const includePseudo = !!opts.includePseudo;
  // v0.41.29.0: `sourceId` (scalar, from `--source` + single-source MCP
  // clients) or `sourceIds` (federated, from `allowedSources` MCP clients)
  // scopes the candidate set. `sourceIds` wins when both set (mirrors
  // sourceScopeOpts precedence).
  const sourceId = opts.sourceId;
  const sourceIds =
    opts.sourceIds && opts.sourceIds.length > 0 ? opts.sourceIds : undefined;
  // The NOT EXISTS anti-join over pages × links can take seconds on 50K-page
  // brains. Heartbeat every second so agents see the scan is alive. Keyset
  // pagination was considered and rejected: without an index on
  // links.to_page_id it does no useful work. Adding that index is a
  // follow-up (v0.14.3 schema migration).
  // User-configured deny prefixes — read once per findOrphans call so
  // both the per-page-filter pass below AND the denominator pass apply
  // the same set. If they fell out of sync (e.g. caller-supplied vs
  // engine-read), the F6 invariant about denominator correctness would
  // break and excluded pages with inbound links would silently re-enter
  // total_linkable.
  const userPrefixes = await readUserExcludePrefixes(engine);
  // Issue #2215 follow-on: page-type exclusions. Filtered at the SQL
  // level (engine.findOrphanPages + the denominator query) rather than
  // post-loop because the orphan list does not return `pages.type`. If
  // we moved this to a JS-side filter, the denominator query would need
  // a parallel pull of (slug, type) for every live page — strictly more
  // work than the `type <> ALL($)` clause that filters at the index.
  const excludeTypes = await readExcludeTypes(engine);

  const progress = createProgress(cliOptsToProgressOptions(getCliOptions()));
  progress.start('orphans.scan');
  const stopHb = startHeartbeat(progress, 'scanning pages for missing inbound links…');
  let allOrphans: { slug: string; title: string; domain: string | null }[];
  let total: number;
  let excludedAll: number;
  try {
    allOrphans = await engine.findOrphanPages({
      ...(sourceIds ? { sourceIds } : sourceId ? { sourceId } : {}),
      ...(excludeTypes.length > 0 ? { excludeTypes } : {}),
    });
    // v0.41.29.0 (Codex F6): correct the `total_linkable` denominator.
    // Enumerate ALL live pages (scoped) and count excluded-by-slug across
    // the WHOLE set — not just among orphans. The old
    // `total - excludedOrphans` left excluded NON-orphan pages (e.g. a
    // `test/` page that HAS inbound links) in the denominator, inflating
    // total_linkable and suppressing orphan warnings. `getAllSlugs` is NOT
    // used here because it does not filter soft-deleted rows; `total` must
    // match `findOrphanPages`'s `deleted_at IS NULL` candidate universe.
    //
    // Issue #2215 follow-on: when excludeTypes is non-empty, the
    // denominator also drops those types so `total_linkable` matches the
    // candidate-set semantics. Without this, the ratio would understate
    // the per-vault orphan rate by counting type-excluded pages the
    // numerator never saw.
    let scopeClause = '';
    const liveParams: unknown[] = [];
    if (sourceIds) {
      liveParams.push(sourceIds);
      scopeClause = ` AND source_id = ANY($${liveParams.length}::text[])`;
    } else if (sourceId) {
      liveParams.push(sourceId);
      scopeClause = ` AND source_id = $${liveParams.length}`;
    }
    if (excludeTypes.length > 0) {
      liveParams.push(excludeTypes);
      scopeClause += ` AND type <> ALL($${liveParams.length}::text[])`;
    }
    const liveRows = await engine.executeRaw<{ slug: string }>(
      `SELECT slug FROM pages WHERE deleted_at IS NULL${scopeClause}`,
      liveParams,
    );
    total = liveRows.length;
    excludedAll = includePseudo
      ? 0
      : liveRows.reduce((n, r) => n + (shouldExclude(r.slug, userPrefixes) ? 1 : 0), 0);
  } finally {
    stopHb();
    progress.finish();
  }

  const filtered = includePseudo
    ? allOrphans
    : allOrphans.filter(row => !shouldExclude(row.slug, userPrefixes));

  const orphans: OrphanPage[] = filtered.map(row => ({
    slug: row.slug,
    title: row.title,
    domain: deriveDomain(row.domain, row.slug),
  }));

  const excluded = allOrphans.length - filtered.length;

  return {
    orphans,
    total_orphans: orphans.length,
    // v0.41.29.0 (Codex F6): denominator = live pages minus ALL excluded
    // pages (orphan or not), so excluded pages with inbound links no longer
    // inflate it.
    total_linkable: total - excludedAll,
    total_pages: total,
    excluded,
  };
}

/**
 * v0.42.0.0 D1: canonical name for the pure data fn consumed by both
 * `gbrain orphans` CLI AND doctor's `orphan_ratio` check. Aliased to
 * `findOrphans` so the existing CLI behavior + the test surface stay
 * byte-identical; new consumers should import `getOrphansData` to make
 * the data-only intent explicit at the call site.
 */
export const getOrphansData = findOrphans;

// --- Output formatters ---

export function formatOrphansText(result: OrphanResult): string {
  const lines: string[] = [];

  const { orphans, total_orphans, total_linkable, total_pages, excluded } = result;
  lines.push(
    `${total_orphans} orphans out of ${total_linkable} linkable pages (${total_pages} total; ${excluded} excluded)\n`,
  );

  if (orphans.length === 0) {
    lines.push('No orphan pages found.');
    return lines.join('\n');
  }

  // Group by domain, sort alphabetically within each group
  const byDomain = new Map<string, OrphanPage[]>();
  for (const page of orphans) {
    const list = byDomain.get(page.domain) || [];
    list.push(page);
    byDomain.set(page.domain, list);
  }

  // Sort domains alphabetically
  const sortedDomains = [...byDomain.keys()].sort();
  for (const domain of sortedDomains) {
    const pages = byDomain.get(domain)!.sort((a, b) => a.slug.localeCompare(b.slug));
    lines.push(`[${domain}]`);
    for (const page of pages) {
      lines.push(`  ${page.slug}  ${page.title}`);
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

// --- CLI entry point ---

export async function runOrphans(engine: BrainEngine, args: string[]) {
  const json = args.includes('--json');
  const count = args.includes('--count');
  const includePseudo = args.includes('--include-pseudo');
  // v0.41.29.0: explicit `--source <id>` scopes the orphan scan to one
  // source. Omitted → brain-wide (unchanged). Raw explicit-flag parse on
  // purpose — NOT resolveSourceWithTier, which would pick a default source
  // when the flag is absent and silently scope a bare `gbrain orphans`.
  let sourceId: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--source' && i + 1 < args.length) {
      sourceId = args[++i] || undefined;
    }
  }

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`Usage: gbrain orphans [options]

Find pages with no inbound wikilinks.

Options:
  --json            Output as JSON (for agent consumption)
  --count           Output just the number of orphans
  --include-pseudo  Include auto-generated and pseudo pages in results
  --source <id>     Scope the scan to one brain source (default: brain-wide)
  --help, -h        Show this help

Output (default): grouped by domain, sorted alphabetically within each group
Summary line: N orphans out of M linkable pages (K total; K-M excluded)

The shipped exclusion set covers gbrain-internal convention dirs (output/,
templates/, scripts/, dashboards/, openclaw/config/), pseudo-pages
(_index, _atlas, _scratch, ...), auto-generated suffixes (/_index, /log),
raw-source slug segments (/raw/), and first-segment dirs (scratch/,
thoughts/, catalog/, entities/). Brains organized by other conventions
extend the list via config:

  gbrain config set orphans.exclude_prefixes 'resources/,transcripts/,agents/'

Comma-separated, whitespace tolerated, additive to the shipped defaults.

Shipped page-type defaults always apply: code, extract_receipt, feat, fix,
refactor, chore. Code-symbol extractions, system artifacts, and
gstack-memory-ingest commit-summary pages have no inbound-link semantics
by construction. Extend the list via config:

  gbrain config set orphans.exclude_types 'guide,reference'

Comma-separated, whitespace tolerated, ADDITIVE to the shipped defaults.
Strict-equality on pages.type. Applies to both the orphan list AND the
total_linkable denominator so the per-vault ratio stays honest.
`);
    return;
  }

  const result = await findOrphans(engine, { includePseudo, sourceId });

  if (count) {
    console.log(String(result.total_orphans));
    return;
  }

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(formatOrphansText(result));
}
