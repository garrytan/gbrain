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

// --- Filter logic ---

/**
 * Returns true if a slug should be excluded from orphan reporting by default.
 * These are pages where having no inbound links is expected / not a content problem.
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
 */
export async function findOrphans(
  engine: BrainEngine,
  opts: { includePseudo?: boolean } = {},
): Promise<OrphanResult> {
  const includePseudo = !!opts.includePseudo;
  // The NOT EXISTS anti-join over pages × links can take seconds on 50K-page
  // brains. Heartbeat every second so agents see the scan is alive. Keyset
  // pagination was considered and rejected: without an index on
  // links.to_page_id it does no useful work. Adding that index is a
  // follow-up (v0.14.3 schema migration).
  const progress = createProgress(cliOptsToProgressOptions(getCliOptions()));
  progress.start('orphans.scan');
  const stopHb = startHeartbeat(progress, 'scanning pages for missing inbound links…');
  let allOrphans: { slug: string; title: string; domain: string | null }[];
  let total: number;
  try {
    allOrphans = await engine.findOrphanPages();
    // Count total pages in DB for the summary line
    const stats = await engine.getStats();
    total = stats.page_count;
  } finally {
    stopHb();
    progress.finish();
  }
  const _totalPages = allOrphans.length; // pages with no inbound links (preserved for ref)

  const filtered = includePseudo
    ? allOrphans
    : allOrphans.filter(row => !shouldExclude(row.slug));

  const orphans: OrphanPage[] = filtered.map(row => ({
    slug: row.slug,
    title: row.title,
    domain: deriveDomain(row.domain, row.slug),
  }));

  const excluded = allOrphans.length - filtered.length;

  return {
    orphans,
    total_orphans: orphans.length,
    total_linkable: filtered.length + (total - allOrphans.length),
    total_pages: total,
    excluded,
  };
}

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

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`Usage: gbrain orphans [options]

Find pages with no inbound wikilinks.

Options:
  --json            Output as JSON (for agent consumption)
  --count           Output just the number of orphans
  --include-pseudo  Include auto-generated and pseudo pages in results
  --help, -h        Show this help

Output (default): grouped by domain, sorted alphabetically within each group
Summary line: N orphans out of M linkable pages (K total; K-M excluded)
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
