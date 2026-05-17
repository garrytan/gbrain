/**
 * gbrain orphans — Surface ISLANDED pages (no inbound AND no outbound).
 *
 * Deterministic: zero LLM calls. Routes through `engine.findIslandedPages()`
 * which shares its SQL predicate with `getHealth.orphan_pages`, so the
 * count this command reports equals the `brain_score` orphan_pages count
 * by construction (v0.33+ step-4 alignment).
 *
 * The JS-side `shouldExclude` filter is retained as an exported helper
 * for backwards-compat tests + agent consumers that may inspect a slug
 * outside the SQL path, but `findOrphans` no longer runs it — the SQL
 * predicate is the runtime authority.
 *
 * Usage:
 *   gbrain orphans                  # list islanded pages grouped by domain
 *   gbrain orphans --json           # JSON output for agent consumption
 *   gbrain orphans --count          # just the number
 *   gbrain orphans --include-pseudo # relax exclusions; islanded predicate unchanged
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
  total_pages: number;
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
  // Source-type ingestions: no inbound wikilinks is the healthy default.
  // These pages are anchored via timeline entries / parent records, not by
  // being cited from concept pages. Without exclusion they dominate orphan
  // counts and crush no_orphans_score for reasons unrelated to graph rot.
  'emails/',
  'attachments/',
  '0-daily/',
  '4-archive/',
  // Navigation pages are vault-level hub-target pages (Obsidian graph-view
  // clustering anchors — body literally reads "Notes linking here appear in
  // the graph view as connected to this hub"). They exist to organize the
  // graph, not to carry content; missing inbound = sparse [[wikilink]] usage
  // in the vault, not graph rot. Excluding them keeps brain_score focused on
  // real content rot.
  'navigation/',
];

/** First slug segments where no inbound links is expected */
const FIRST_SEGMENT_EXCLUSIONS = new Set(['scratch', 'thoughts', 'catalog', 'entities']);

// --- Filter logic ---

/**
 * @deprecated v0.33+ step-4 alignment: SQL is now the runtime authority for
 * orphan exclusion (see `findIslandedPages` in both engines). This helper is
 * retained only for backwards-compat unit tests + any out-of-band JS-side
 * consumer inspecting a single slug. New code should not call it from the
 * runtime path — the engine's predicate is single-source-of-truth.
 *
 * Returns true if a slug would be excluded by the SQL predicate.
 */
export function shouldExclude(slug: string): boolean {
  // Pseudo-pages (exact match)
  if (PSEUDO_SLUGS.has(slug)) return true;

  // Auto-generated suffix patterns
  for (const suffix of AUTO_SUFFIX_PATTERNS) {
    if (slug.endsWith(suffix)) return true;
  }

  // Raw source slugs
  if (slug.includes(RAW_SEGMENT)) return true;

  // Deny-prefix slugs
  for (const prefix of DENY_PREFIXES) {
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
 * Returns raw rows (all pages with zero inbound, soft-deleted excluded).
 *
 * Kept for backwards-compat tests + enrichment-pattern consumers.
 * v0.33+ step-4 alignment: the user-visible orphan surface now uses
 * `findIslandedPages` via `findOrphans` below.
 */
export async function queryOrphanPages(
  engine: BrainEngine,
): Promise<{ slug: string; title: string; domain: string | null }[]> {
  return engine.findOrphanPages();
}

/**
 * Find islanded pages, with optional pseudo-page surfacing.
 * Returns structured OrphanResult with totals.
 *
 * v0.33+ step-4 alignment: routes through `engine.findIslandedPages()`
 * whose SQL predicate matches `getHealth.orphan_pages` by construction,
 * so `result.total_orphans === (await engine.getHealth()).orphan_pages`.
 *
 * `opts.includePseudo=true` relaxes the SQL exclusion set (surfaces
 * auto-generated / pseudo-page slugs) but does NOT change the islanded
 * graph predicate. Per Codex pre-impl: --include-pseudo means "show me
 * more rows", never "redefine what an orphan is".
 */
export async function findOrphans(
  engine: BrainEngine,
  opts: { includePseudo?: boolean } = {},
): Promise<OrphanResult> {
  const includePseudo = !!opts.includePseudo;
  // The two NOT EXISTS anti-joins over pages × links can take seconds on
  // 50K-page brains. Heartbeat every second so agents see the scan is
  // alive. links indexes (to_page_id, from_page_id) keep this responsive
  // on Colin's 10K-page brain (~600ms).
  const progress = createProgress(cliOptsToProgressOptions(getCliOptions()));
  progress.start('orphans.scan');
  const stopHb = startHeartbeat(progress, 'scanning pages for islanded (no in + no out) links…');
  let islandedRows: { slug: string; title: string; domain: string | null }[];
  let total: number;
  try {
    islandedRows = await engine.findIslandedPages({ includePseudo });
    const stats = await engine.getStats();
    total = stats.page_count;
  } finally {
    stopHb();
    progress.finish();
  }

  const orphans: OrphanPage[] = islandedRows.map(row => ({
    slug: row.slug,
    title: row.title,
    domain: deriveDomain(row.domain, row.slug),
  }));

  return {
    orphans,
    total_orphans: orphans.length,
    total_pages: total,
  };
}

// --- Output formatters ---

export function formatOrphansText(result: OrphanResult): string {
  const lines: string[] = [];

  const { orphans, total_orphans, total_pages } = result;
  lines.push(
    `${total_orphans} islanded pages out of ${total_pages} total\n`,
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

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`Usage: gbrain orphans [options]

Find ISLANDED pages — no inbound AND no outbound wikilinks. By default the
authoritative exclusion set (source-type ingestions, vault wayfinding,
pseudo-page slugs, suffix/segment patterns, first-segment exclusions) is
applied at the SQL layer, so this count equals get_health.orphan_pages.

Options:
  --json            Output as JSON (for agent consumption)
  --count           Output just the number of islanded pages
  --include-pseudo  Relax the exclusion set (surface auto-generated and
                    pseudo pages). The islanded graph predicate is
                    unchanged — this flag never widens beyond "no in AND
                    no out".
  --help, -h        Show this help

Output (default): grouped by domain, sorted alphabetically within each group
Summary line: N islanded pages out of K total
`);
    return;
  }

  const result = await findOrphans(engine, { includePseudo });

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
