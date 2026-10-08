/**
 * Timeline extraction from rendered markdown — CORE module.
 *
 * Lives in core (not commands/extract.ts, its historical home) because core
 * consumers (timeline-write-through.ts re-derives the canonical DB tuple from
 * the spliced bullet; the cycle synthesize path) must not import the command
 * module: commands/extract.ts transitively loads the write-through/ops layer,
 * and a core->commands import closes a module cycle that leaves the command
 * module partially evaluated under dynamic import ("Export named ... not
 * found" at runtime, invisible to tsc). commands/extract.ts re-exports these
 * names, so its existing importers are unaffected.
 */

import { parseInlineCitationTimelineEntries, findTimelineSourceDelimiter, parseTimelineEntries } from './link-extraction.ts';
import { isDatedTimelineLine, supersededInlineCitationEntries } from './timeline-citations.ts';
import type { BrainEngine } from './engine.ts';
import { firstMaterializedMarkerIndex } from './timeline-marker.ts';

export interface ExtractedTimelineEntry {
  slug: string;
  date: string;
  source: string;
  summary: string;
  detail?: string;
}

// #3957: the link-aware `Source — Summary` delimiter finder moved to
// link-extraction.ts (findTimelineSourceDelimiter) so the DB-side parser
// (parseTimelineEntries) applies the IDENTICAL split — FS- and DB-extracted
// rows must share one (source, summary) shape or the timeline dedup index
// duplicates every bullet extracted through both paths.
const findDelimiterOutsideLinks = findTimelineSourceDelimiter;

// A Format 1 bullet line; this extractor's inline-citation pass (Format 3) skips it.
const bulletLinePattern = /^-\s+\*\*\d{4}-\d{2}-\d{2}\*\*\s*\|/;

/** Extract timeline entries from markdown content */
export function extractTimelineFromContent(content: string, slug: string): ExtractedTimelineEntry[] {
  const entries: ExtractedTimelineEntry[] = [];

  // Format 1: Bullet — - **YYYY-MM-DD** | Source — Summary
  // The delimiter search is link-aware (see findDelimiterOutsideLinks): a
  // no-delimiter bullet is kept whole as the summary rather than fragmented.
  const bulletPattern = /^-\s+\*\*(\d{4}-\d{2}-\d{2})\*\*\s*\|\s*(.+)$/gm;
  let match;
  while ((match = bulletPattern.exec(content)) !== null) {
    const rest = match[2].trim();
    // #4277: dated auto-generated backlink receipts
    // (`- **date** | Referenced in [X](y.md)`) are graph-maintenance noise —
    // the date is the backlink write's, not an entity event's. Skip them.
    // Pre-split guard (rest must START with the marker) mirrors
    // parseTimelineEntries in link-extraction.ts so FS- and DB-side
    // extraction stay in lockstep, and leaves write-through rendered
    // `source — summary` bullets that merely mention the phrase intact.
    if (/^Referenced in\s+\[/i.test(rest)) continue;
    const at = findDelimiterOutsideLinks(rest);
    if (at >= 0) {
      entries.push({ slug, date: match[1], source: rest.slice(0, at).trim(), summary: rest.slice(at + 1).trim() });
    } else {
      entries.push({ slug, date: match[1], source: 'markdown', summary: rest });
    }
  }

  // Format 2: Header — ### YYYY-MM-DD — Title
  const headerPattern = /^###\s+(\d{4}-\d{2}-\d{2})\s*[—–-]\s*(.+)$/gm;
  while ((match = headerPattern.exec(content)) !== null) {
    const afterIdx = match.index + match[0].length;
    const nextHeader = content.indexOf('\n### ', afterIdx);
    const nextSection = content.indexOf('\n## ', afterIdx);
    const endIdx = Math.min(
      nextHeader >= 0 ? nextHeader : content.length,
      nextSection >= 0 ? nextSection : content.length,
    );
    // #5567: a materialized bullet appended after this header is its own entry.
    const section = content.slice(afterIdx, endIdx);
    const marker = firstMaterializedMarkerIndex(section);
    const detail = (marker >= 0 ? section.slice(0, marker) : section).trim();
    entries.push({ slug, date: match[1], source: 'markdown', summary: match[2].trim(), detail: detail || undefined });
  }

  // Format 3: Inline citation — [Source: <source>, YYYY-MM-DD]
  //
  // This is the citation convention gbrain's own quality rules require on
  // every brain write (skills/conventions/quality.md), so dated evidence is
  // pervasive in curated pages — but until now the extractor could not see
  // it, and a page whose dates all live in citations scored zero timeline
  // coverage. The entry's summary is the sentence the citation annotates
  // (the surrounding line with citation markers stripped).
  //
  // Lines already captured by Format 1 are skipped: a timeline bullet often
  // carries its own [Source: ...] citation, and re-extracting it would file
  // a duplicate entry under a different (source, summary) shape that the
  // DB-level uniqueness cannot collapse.
  for (const entry of parseInlineCitationTimelineEntries(content, {
    skipLine: (line) => bulletLinePattern.test(line),
  })) {
    entries.push({ slug, date: entry.date, source: entry.source, summary: entry.summary });
  }

  return entries;
}

type TimelineTuple = Pick<ExtractedTimelineEntry, 'date' | 'source' | 'summary'>;
const tupleKey = (e: TimelineTuple) => JSON.stringify([e.date, e.source, e.summary]);

/**
 * #6226: the tuples the inline-citation pass of either parser filed for this
 * text before one citation could name several dated sources, and that the
 * current reading no longer produces (supersededInlineCitationEntries).
 */
export function supersededCitationTimeline(content: string): TimelineTuple[] {
  return [
    ...supersededInlineCitationEntries(content, { skipLine: (line) => bulletLinePattern.test(line) }),
    ...supersededInlineCitationEntries(content, { skipLine: isDatedTimelineLine }),
  ];
}

/**
 * The detail an extractor itself writes for a citation row: none (file
 * extraction) or `Source: <source>` (database extraction). Any other detail
 * was added by someone, so a row carrying it is never retired as an older
 * reading (#6226, taste T3): timelineKey ignores detail.
 */
export function hasExtractorDetail(row: { source: string; detail?: string | null }): boolean {
  const detail = (row.detail ?? '').replace(/\s+/g, ' ').trim();
  return detail === '' || detail === `Source: ${row.source}`.replace(/\s+/g, ' ').trim();
}

/**
 * Every (date, source, summary) tuple a page text yields under either timeline
 * parser: the file-walk parser above and the DB-side parseTimelineEntries.
 * Reconciliation keeps and retracts against this union, so the file and DB
 * extraction paths never undo each other's rows.
 */
function markdownTimelineKeys(text: string, slug: string): Set<string> {
  const keys = new Set(extractTimelineFromContent(text, slug).map(tupleKey));
  for (const entry of parseTimelineEntries(text)) keys.add(tupleKey({ ...entry, source: entry.source ?? '' }));
  return keys;
}

/**
 * Reconcile a page's timeline rows with its current text: retract every row
 * an earlier version of the page produced that the current text no longer
 * does (a corrected or deleted dated bullet, however many edits ago). Rows no
 * version of the page ever produced (enrichment, meeting fan-out, inferred
 * anchors) and event-page projections are never touched. The page_versions
 * scan only runs when the page holds a row the current text does not produce.
 * Returns the orphaned rows; they are deleted unless `dryRun`.
 */
export async function retractRemovedTimelineEntries(
  engine: Pick<BrainEngine, 'executeRaw'>,
  slug: string,
  sourceId: string,
  currentText: string,
  opts: { dryRun?: boolean } = {},
): Promise<Array<TimelineTuple & { id: number }>> {
  const kept = markdownTimelineKeys(currentText, slug);
  const rows = await engine.executeRaw<TimelineTuple & { id: number; detail: string | null }>(
    `SELECT t.id, to_char(t.date, 'YYYY-MM-DD') AS date, t.source, t.summary, t.detail FROM timeline_entries t
      JOIN pages p ON p.id = t.page_id
      WHERE p.source_id = $1 AND p.slug = $2 AND t.event_page_id IS NULL`, [sourceId, slug]);
  const extra = rows.filter(row => !kept.has(tupleKey(row)));
  if (!extra.length) return [];
  const versions = await engine.executeRaw<{ compiled_truth: string; timeline: string | null }>(
    `SELECT DISTINCT v.compiled_truth, v.timeline FROM page_versions v JOIN pages p ON p.id = v.page_id
      WHERE p.source_id = $1 AND p.slug = $2`, [sourceId, slug]);
  const produced = new Set<string>();
  // #6226: rows the older citation reading filed for this text or a stored version.
  const superseded = new Set(supersededCitationTimeline(currentText).map(tupleKey));
  for (const version of versions) {
    const text = `${version.compiled_truth}\n${version.timeline ?? ''}`;
    for (const key of markdownTimelineKeys(text, slug)) produced.add(key);
    for (const entry of supersededCitationTimeline(text)) superseded.add(tupleKey(entry));
  }
  const orphans = extra.filter(row => produced.has(tupleKey(row)) || (superseded.has(tupleKey(row)) && hasExtractorDetail(row)))
    .map(({ detail: _detail, ...row }) => row);
  if (!orphans.length || opts.dryRun) return orphans;
  await engine.executeRaw(
    `DELETE FROM timeline_entries WHERE id IN (SELECT jsonb_array_elements_text($1::text::jsonb)::int)`,
    [JSON.stringify(orphans.map(row => row.id))]);
  return orphans;
}

export interface TimelineOrphanPruneResult {
  pagesScanned: number;
  orphans: number;
  removed: number;
  examples: Array<{ source_id: string; slug: string; date: string; summary: string }>;
}

/**
 * Managed brains guard `timeline_entries`: the retraction runs as a coordinated
 * write under the page lock, against the text read inside that transaction.
 */
async function retractCoordinated(engine: BrainEngine, pageId: number, slug: string, sourceId: string) {
  const { withCoordinatedWrite } = await import('./persistence/context.ts');
  const { maintenanceAttribution } = await import('./persistence/attribution.ts');
  const attribution = await maintenanceAttribution(engine);
  return engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], async () => {
    await tx.lockPageKeys([{ sourceId, slug }]);
    const [page] = await tx.executeRaw<{ compiled_truth: string; timeline: string | null }>(
      'SELECT compiled_truth, timeline FROM pages WHERE id = $1 AND deleted_at IS NULL', [pageId]);
    return page ? retractRemovedTimelineEntries(tx, slug, sourceId, `${page.compiled_truth}\n${page.timeline ?? ''}`) : [];
  }, attribution));
}

/**
 * One-time prune of timeline rows orphaned before extraction reconciled them
 * (#4649): runs the reconciliation above against each page's stored text for
 * every live page that holds timeline rows, optionally scoped to one source
 * and capped at `limit` pages (the doctor check samples; the CLI prunes all).
 */
export async function pruneTimelineOrphans(
  engine: BrainEngine,
  opts: { sourceId?: string; dryRun: boolean; limit?: number; coordinated?: boolean },
): Promise<TimelineOrphanPruneResult> {
  const result: TimelineOrphanPruneResult = { pagesScanned: 0, orphans: 0, removed: 0, examples: [] };
  let afterId = 0;
  for (;;) {
    const pageSize = Math.min(200, (opts.limit ?? Infinity) - result.pagesScanned);
    if (pageSize <= 0) break;
    const params: unknown[] = [afterId, pageSize];
    if (opts.sourceId) params.push(opts.sourceId);
    const pages = await engine.executeRaw<{ id: number; slug: string; source_id: string; compiled_truth: string; timeline: string | null }>(
      `SELECT p.id, p.slug, p.source_id, p.compiled_truth, p.timeline FROM pages p
        WHERE p.id > $1 AND p.deleted_at IS NULL${opts.sourceId ? ' AND p.source_id = $3' : ''}
          AND EXISTS (SELECT 1 FROM timeline_entries t WHERE t.page_id = p.id AND t.event_page_id IS NULL)
        ORDER BY p.id LIMIT $2`, params);
    if (!pages.length) break;
    for (const page of pages) {
      const orphans = opts.coordinated && !opts.dryRun
        ? await retractCoordinated(engine, page.id, page.slug, page.source_id)
        : await retractRemovedTimelineEntries(engine, page.slug, page.source_id, `${page.compiled_truth}\n${page.timeline ?? ''}`, { dryRun: opts.dryRun });
      result.orphans += orphans.length;
      if (!opts.dryRun) result.removed += orphans.length;
      for (const row of orphans.slice(0, Math.max(0, 5 - result.examples.length))) {
        result.examples.push({ source_id: page.source_id, slug: page.slug, date: row.date, summary: row.summary });
      }
    }
    result.pagesScanned += pages.length;
    afterId = pages[pages.length - 1]!.id;
  }
  return result;
}
