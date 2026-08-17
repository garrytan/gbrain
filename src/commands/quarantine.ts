/**
 * gbrain quarantine — operator surface for the content-quality gate (issue #1699).
 *
 *   gbrain quarantine list [--json] [--include-flagged]
 *   gbrain quarantine clear <slug> [--force] [--no-embed] [--json]
 *   gbrain quarantine scan [--limit N] [--apply] [--no-embed] [--json]
 *
 * `quarantine` (hidden) marks high-confidence junk; `content_flag` (warned,
 * still searchable) marks fuzzy markup-heavy / oversize pages. See
 * src/core/quarantine.ts for the marker contract.
 */
import type { BrainEngine } from '../core/engine.ts';
import { isQuarantined, getContentFlag, QUARANTINE_KEY, CONTENT_FLAG_KEY } from '../core/quarantine.ts';
import { serializePageToMarkdown, serializeMarkdown } from '../core/markdown.ts';
import { importFromContent } from '../core/import-file.ts';
import type { PageType } from '../core/types.ts';

export interface QuarantineRow {
  slug: string;
  source_id: string;
  marker: 'quarantine' | 'content_flag';
  reason: string;
  assessed_at: string;
}

export function rowFor(page: { slug: string; source_id?: string; frontmatter?: Record<string, unknown> | null }): QuarantineRow | null {
  const fm = page.frontmatter ?? null;
  if (isQuarantined(fm)) {
    const m = (fm as Record<string, unknown>)[QUARANTINE_KEY] as Record<string, unknown>;
    return {
      slug: page.slug,
      source_id: page.source_id ?? 'default',
      marker: 'quarantine',
      reason: typeof m?.reason === 'string' ? m.reason : 'unknown',
      assessed_at: typeof m?.assessed_at === 'string' ? m.assessed_at : '',
    };
  }
  const flag = getContentFlag(fm);
  if (flag) {
    const m = (fm as Record<string, unknown>)[CONTENT_FLAG_KEY] as Record<string, unknown>;
    return {
      slug: page.slug,
      source_id: page.source_id ?? 'default',
      marker: 'content_flag',
      reason: flag.reason,
      assessed_at: typeof m?.assessed_at === 'string' ? m.assessed_at : '',
    };
  }
  return null;
}

// Bounds for the quarantine_list op's clamps (src/core/ops/admin.ts); the CLI
// list stays unbounded. One canonical home so the op clamps and the param
// descriptions can't drift apart silently.
export const QUARANTINE_LIST_DEFAULT_LIMIT = 200;
export const QUARANTINE_LIST_MAX_LIMIT = 1000;
export const QUARANTINE_SCAN_DEFAULT = 20000;
export const QUARANTINE_SCAN_MAX = 100000;

export interface CollectQuarantineOpts {
  includeFlagged?: boolean;
  /** Max ROWS returned (op default 200, cap 1000). Undefined = unbounded (CLI). */
  limit?: number;
  /** Max PAGES scanned (op default 20000, cap 100000). Undefined = full scan (CLI). */
  maxScan?: number;
  /** Source scope (the op threads sourceScopeOpts; the CLI scans unscoped). */
  sourceId?: string;
  sourceIds?: string[];
}

export interface CollectQuarantineResult {
  rows: QuarantineRow[];
  scanned: number;
  /** True when a bound stopped the scan — `rows.length` is a LOWER BOUND. */
  truncated: boolean;
}

/**
 * Shared frontmatter scan behind `gbrain quarantine list` and the
 * quarantine_list op. Scan order is pinned to listPages' default
 * `updated_desc` (most recently updated pages first), so a bounded scan sees
 * the newest markers before older ones [OV13].
 *
 * [P2-6] Offset pagination over `updated_desc` is NOT a total order:
 * `PAGE_SORT_SQL.updated_desc` is `p.updated_at DESC` with no unique
 * tiebreaker (src/core/types.ts). A cluster of pages sharing an identical
 * `updated_at` (bulk syncs stamp one now() across a transaction) that
 * straddles a 1000-row batch boundary can have a row skipped or duplicated
 * across batches. We accept this rather than switch sorts because the only
 * tiebreaker'd enum option (`updated_asc`, `p.updated_at ASC, p.slug ASC`)
 * reverses the [OV13] direction — a truncated scan (bounded by max_scan /
 * limit) would then surface the OLDEST markers and MISS recent ones, a worse
 * triage failure on large brains, and its slug tiebreaker is only a total
 * order for a single-source scan anyway (the op can scope federated
 * multi-source and the CLI scans unscoped, where slug is not unique). The
 * exposure is bounded: the op caps the scan at max_scan, and only exact
 * same-timestamp clusters landing on a batch boundary are affected. The full
 * fix is a globally-unique page_id tiebreaker in PAGE_SORT_SQL (out of scope
 * here — a filed follow-up), not a SELECT-projection pushdown.
 */
export async function collectQuarantineRows(
  engine: BrainEngine,
  opts: CollectQuarantineOpts = {},
): Promise<CollectQuarantineResult> {
  const rows: QuarantineRow[] = [];
  const PAGE = 1000;
  let offset = 0;
  let scanned = 0;
  let truncated = false;
  outer: for (;;) {
    const pages = await engine.listPages({
      limit: PAGE,
      offset,
      sort: 'updated_desc',
      ...(opts.sourceIds && opts.sourceIds.length > 0
        ? { sourceIds: opts.sourceIds }
        : opts.sourceId ? { sourceId: opts.sourceId } : {}),
    });
    if (pages.length === 0) break;
    for (const p of pages) {
      if (opts.maxScan !== undefined && scanned >= opts.maxScan) { truncated = true; break outer; }
      scanned += 1;
      const r = rowFor(p);
      if (!r) continue;
      if (r.marker === 'content_flag' && !opts.includeFlagged) continue;
      rows.push(r);
      if (opts.limit !== undefined && rows.length >= opts.limit) { truncated = true; break outer; }
    }
    if (pages.length < PAGE) break;
    offset += PAGE;
  }
  return { rows, scanned, truncated };
}

async function runList(engine: BrainEngine, args: string[]): Promise<void> {
  const json = args.includes('--json');
  const includeFlagged = args.includes('--include-flagged');
  const { rows } = await collectQuarantineRows(engine, { includeFlagged });

  if (json) {
    console.log(JSON.stringify({ schema_version: 1, count: rows.length, rows }, null, 2));
    return;
  }
  if (rows.length === 0) {
    console.log(
      includeFlagged
        ? 'No quarantined or flagged pages.'
        : "No quarantined pages. (Pass --include-flagged to also list content_flag pages.)",
    );
    return;
  }
  for (const r of rows) {
    const src = r.source_id === 'default' ? '' : ` [${r.source_id}]`;
    console.log(`  ${r.marker === 'quarantine' ? 'HIDDEN ' : 'FLAGGED'} ${r.slug}${src}  reason=${r.reason}  at=${r.assessed_at}`);
  }
  const hidden = rows.filter((r) => r.marker === 'quarantine').length;
  const flagged = rows.length - hidden;
  console.log(`\n${hidden} quarantined (hidden), ${flagged} flagged (searchable, warned).`);
}

async function runClear(engine: BrainEngine, args: string[]): Promise<void> {
  const json = args.includes('--json');
  const force = args.includes('--force');
  const noEmbed = args.includes('--no-embed');
  const srcIdx = args.indexOf('--source-id');
  const sourceIdFlag = srcIdx >= 0 && args[srcIdx + 1] && !args[srcIdx + 1].startsWith('--')
    ? args[srcIdx + 1]
    : undefined;
  // First non-flag positional after the subcommand is the slug (skip the
  // --source-id value so it can't be mistaken for the slug).
  const slug = args.find((a, i) => !a.startsWith('--') && !(srcIdx >= 0 && i === srcIdx + 1));
  if (!slug) {
    console.error('Usage: gbrain quarantine clear <slug> [--source-id <id>] [--force] [--no-embed]');
    process.exit(2);
  }
  // Deterministic source resolution: an unscoped getPage on a slug that
  // exists in multiple sources returns an arbitrary row, and the re-import
  // below writes to WHATEVER source that read happened to hit. Resolve the
  // candidate sources explicitly; ambiguity is an error, not a coin flip.
  let sourceId = sourceIdFlag;
  if (!sourceId) {
    const rows = await engine.executeRaw<{ source_id: string }>(
      `SELECT source_id FROM pages WHERE slug = $1 AND deleted_at IS NULL ORDER BY source_id`,
      [slug],
    );
    if (rows.length > 1) {
      console.error(
        `Slug "${slug}" exists in ${rows.length} sources: ${rows.map(r => r.source_id).join(', ')}.\n` +
        `Pick one with: gbrain quarantine clear ${slug} --source-id <id>`,
      );
      process.exit(2);
    }
    sourceId = rows[0]?.source_id;
  }
  // sourceId is resolved above whenever ANY row exists; zero candidates means
  // the page doesn't exist in any source, so the 'default' fallback read
  // returns null and we error below either way.
  const page = await engine.getPage(slug, { sourceId: sourceId ?? 'default' });
  if (!page) {
    console.error(`No page found for slug "${slug}"${sourceIdFlag ? ` in source "${sourceIdFlag}"` : ''}.`);
    process.exit(2);
  }
  const fm = { ...((page.frontmatter ?? {}) as Record<string, unknown>) };
  if (!isQuarantined(fm) && !getContentFlag(fm)) {
    console.log(`Page "${slug}" carries no quarantine or content_flag marker — nothing to clear.`);
    return;
  }
  // Drop both markers, then re-import through the normal pipeline so the page
  // re-chunks + re-embeds and becomes searchable again. The gate re-runs on
  // import: if the page is STILL detected as junk it re-quarantines (reported
  // below) unless --force bypasses the gate for this one import.
  delete fm[QUARANTINE_KEY];
  delete fm[CONTENT_FLAG_KEY];
  const tags = await engine.getTags(slug, { sourceId: page.source_id });
  // Serialize from the CLEANED frontmatter directly (NOT serializePageToMarkdown,
  // which re-spreads page.frontmatter as the base and would re-introduce the
  // markers we just deleted).
  const markdown = serializeMarkdown(fm, page.compiled_truth ?? '', page.timeline ?? '', {
    type: (page.type as PageType) ?? 'note',
    title: page.title ?? '',
    tags,
  });

  const prevNoSanity = process.env.GBRAIN_NO_SANITY;
  if (force) process.env.GBRAIN_NO_SANITY = '1';
  let result;
  try {
    result = await importFromContent(engine, slug, markdown, {
      sourceId: page.source_id,
      noEmbed,
      forceRechunk: true,
    });
  } finally {
    if (force) {
      if (prevNoSanity === undefined) delete process.env.GBRAIN_NO_SANITY;
      else process.env.GBRAIN_NO_SANITY = prevNoSanity;
    }
  }

  const reQuarantined = result.quarantined === true;
  if (json) {
    console.log(JSON.stringify({ slug, cleared: !reQuarantined, re_quarantined: reQuarantined, flagged: result.flagged ?? false, forced: force }, null, 2));
    return;
  }
  if (reQuarantined) {
    console.error(
      `Page "${slug}" is STILL detected as junk — it remained quarantined. ` +
      `Edit the source file to fix it, or re-run with --force to clear it anyway.`,
    );
    process.exit(1);
  }
  console.log(
    `Cleared "${slug}".` +
    (result.flagged ? ` (now flagged: ${result.flag_reason} — searchable, agent warned.)` : '') +
    (noEmbed ? ' Embedding skipped (--no-embed); run `gbrain embed --stale` to make it searchable.' : ''),
  );
}

async function runScan(engine: BrainEngine, args: string[]): Promise<void> {
  const json = args.includes('--json');
  const apply = args.includes('--apply');
  const noEmbed = args.includes('--no-embed');
  const limIdx = args.indexOf('--limit');
  const limit = limIdx !== -1 && args[limIdx + 1] ? parseInt(args[limIdx + 1], 10) : Infinity;

  // Re-import already-ingested pages through the gate so markers get applied
  // to junk that predates the gate (unchanged content short-circuits normal
  // sync, so it never gets re-assessed otherwise). forceRechunk bypasses the
  // content-hash short-circuit.
  //
  // Resolve the effective content_sanity config ONCE so the dry-run assessor
  // uses the SAME thresholds importFromContent will use on --apply — otherwise
  // a brain with custom bytes_warn / max_markup_ratio / prose_check_enabled
  // sees a dry-run count that doesn't match what --apply actually does.
  const { assessContentSanity } = await import('../core/content-sanity.ts');
  const { loadOperatorLiterals } = await import('../core/content-sanity-literals.ts');
  const { loadConfig, loadConfigWithEngine } = await import('../core/config.ts');
  let effCs: NonNullable<import('../core/config.ts').GBrainConfig['content_sanity']> = {};
  try {
    effCs = (await loadConfigWithEngine(engine, loadConfig()))?.content_sanity ?? {};
  } catch { /* fall back to defaults if DB-config lift fails */ }
  const scanLiterals = effCs.junk_patterns_enabled !== false ? loadOperatorLiterals() : [];

  const refs = await engine.listAllPageRefs();
  let scanned = 0;
  let quarantined = 0;
  let flagged = 0;
  const touched: Array<{ slug: string; outcome: 'quarantine' | 'flag' }> = [];

  for (const ref of refs) {
    if (scanned >= limit) break;
    scanned++;
    const page = await engine.getPage(ref.slug, { sourceId: ref.source_id });
    if (!page) continue;
    // Skip pages already marked (idempotent re-runs) — quarantined OR flagged,
    // so --apply doesn't re-chunk/re-embed already-flagged pages every run.
    const pfm = page.frontmatter as Record<string, unknown> | null;
    if (isQuarantined(pfm) || getContentFlag(pfm)) continue;

    if (!apply) {
      // Dry-run: assess read-only (re-import would mutate). Same thresholds as --apply.
      const res = assessContentSanity({
        compiled_truth: page.compiled_truth ?? '',
        timeline: page.timeline ?? '',
        title: page.title ?? '',
        bytes_warn: effCs.bytes_warn,
        bytes_block: effCs.bytes_block,
        max_markup_ratio: effCs.max_markup_ratio,
        prose_check_enabled: effCs.prose_check_enabled,
        page_kind: page.type,
        extra_literals: scanLiterals,
      });
      if (res.shouldQuarantine) {
        quarantined++;
        touched.push({ slug: ref.slug, outcome: 'quarantine' });
      } else if (res.shouldFlag) {
        flagged++;
        touched.push({ slug: ref.slug, outcome: 'flag' });
      }
      continue;
    }

    // --apply: re-import so the gate sets markers + (for quarantine) drops chunks.
    const tags = await engine.getTags(ref.slug, { sourceId: ref.source_id });
    const markdown = serializePageToMarkdown(page, tags);
    const result = await importFromContent(engine, ref.slug, markdown, {
      sourceId: ref.source_id,
      noEmbed,
      forceRechunk: true,
    });
    if (result.quarantined) {
      quarantined++;
      touched.push({ slug: ref.slug, outcome: 'quarantine' });
    } else if (result.flagged) {
      flagged++;
      touched.push({ slug: ref.slug, outcome: 'flag' });
    }
  }

  if (json) {
    console.log(JSON.stringify({ schema_version: 1, applied: apply, scanned, quarantined, flagged, touched }, null, 2));
    return;
  }
  const verb = apply ? '' : '(dry-run) would ';
  console.log(`Scanned ${scanned} page(s): ${verb}quarantine ${quarantined}, ${verb}flag ${flagged}.`);
  if (!apply && (quarantined > 0 || flagged > 0)) {
    console.log('Re-run with --apply to set the markers.');
  }
}

export async function runQuarantine(engine: BrainEngine, args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case 'list':
      return runList(engine, rest);
    case 'clear':
      return runClear(engine, rest);
    case 'scan':
      return runScan(engine, rest);
    default:
      console.error('Usage: gbrain quarantine <list|clear|scan> [...]');
      console.error('  list  [--json] [--include-flagged]');
      console.error('  clear <slug> [--force] [--no-embed] [--json]');
      console.error('  scan  [--limit N] [--apply] [--no-embed] [--json]');
      process.exit(2);
  }
}
