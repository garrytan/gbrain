import type { BrainEngine } from '../engine.ts';
import { LINK_EXTRACTOR_VERSION_TS } from '../link-extraction.ts';
import { isQuarantined } from '../quarantine.ts';
import { prepareAutomaticLinks } from './links-preparation.ts';
import { withCoordinatedWrite } from './context.ts';
import { maintenanceAttribution } from './attribution.ts';
import { unrecordedCanonicalTimeline } from './canonical-projections.ts';
import { runMentionPass, type MentionPassResult } from '../mentions/pass.ts';
import { formatMentionSummary, linkPhaseDeadline, mentionJsonFields, previewMentionPass } from '../mentions/stale.ts';

export interface ManagedLinkExtraction { pages: number; created: number; removed: number; timeline: number; skipped: number; remaining: number;
  /** The mention pass (absent when the caller ran links only, as sync does). */
  mentions?: MentionPassResult; mention_due?: number; mention_last_pass_at?: string | null; }

/** `gbrain extract --stale` on a managed brain, locally or inside the PGLite owner. */
export async function runManagedStaleExtraction(engine: BrainEngine, opts: { sourceId?: string; dryRun?: boolean }): Promise<ManagedLinkExtraction> {
  if (!opts.dryRun) return extractManagedStaleLinks(engine, { sourceId: opts.sourceId });
  const remaining = await engine.countStalePagesForExtraction({ sourceId: opts.sourceId, versionTs: LINK_EXTRACTOR_VERSION_TS });
  const m = await previewMentionPass(engine, opts.sourceId);
  return { pages: 0, created: 0, removed: 0, timeline: 0, skipped: 0, remaining, mention_due: m.due, mention_last_pass_at: m.last_pass_at };
}

/** The `extract --stale` report for a managed brain, in the same text and JSON shapes as the unmanaged sweep. */
export function formatManagedStaleExtraction(result: ManagedLinkExtraction, dryRun: boolean, json: boolean): string {
  if (json) {
    return JSON.stringify(dryRun ? { action: 'extract_stale_dry_run', stale_pages: result.remaining, mention_due_pages: result.mention_due ?? 0,
      mention_last_pass_at: result.mention_last_pass_at ?? null } : {
      action: 'extract_stale_done', links_created: result.created, links_removed: result.removed, timeline_created: result.timeline,
      pages_processed: result.pages, stale_remaining: result.remaining + (result.mentions?.remaining ?? 0),
      ...(result.skipped ? { skipped_changed: result.skipped } : {}), ...(result.mentions ? mentionJsonFields(result.mentions) : {}),
    });
  }
  if (dryRun) {
    return `(dry run) ${result.remaining} page(s) need link/timeline extraction; ${result.mention_due ?? 0} page(s) need a mention pass ` +
      `(last pass: ${result.mention_last_pass_at ?? 'never'}). Run without --dry-run to extract.`;
  }
  const mentionLine = result.mentions ? formatMentionSummary(result.mentions) : null;
  return `Extract --stale: ${result.created} link(s) created, ${result.removed} removed, ${result.timeline} timeline entr(ies) from ${result.pages} page(s).` +
    (result.skipped ? ` Skipped ${result.skipped} page(s) edited during extraction or with unresolved attendance; they stay stale.` : '') +
    (result.remaining ? ` ${result.remaining} page(s) remain stale.` : '') + (mentionLine ? `\n${mentionLine}` : '');
}

/**
 * Derive markdown links with put_page's contract: the page's own derived edges
 * are replaced by what its current text supports, other producers' edges stay.
 * `slugs` (a sync's committed imports) are re-derived regardless of their
 * watermark, because a concurrent sweep may have stamped them mid-sync before
 * their link targets existed; then pages whose watermark is stale follow. Each
 * page's links and watermark commit together, bound to the revision that was
 * read; a page edited meanwhile, or with unresolved attendance, stays stale.
 * Then, unless `mentions: false` (sync's inline extraction), the mention pass
 * runs (mentions/pass.ts); a budgeted run gives link work half the budget
 * while mention-due pages exist.
 * An unresolved-attendance page is marked attendance-blocked at the revision
 * read (doctor reports it apart from lag) and is still reconsidered every run;
 * publishing its links later clears the marker with the watermark.
 * Timeline tuples the coordinator projects from the page body but has no stored
 * row for (a page published before timeline projection) are added in the same
 * coordinated transaction, insert-only. This is the one managed extraction
 * path: sync, `extract --stale` (every caller of extractStaleFromDB) and the
 * PGLite owner delegation all run it, in the process that owns the brain.
 */
export async function extractManagedStaleLinks(engine: BrainEngine,
  opts: { sourceId?: string; slugs?: readonly string[]; maxPages?: number; timeBudgetMs?: number; signal?: AbortSignal; mentions?: boolean } = {}): Promise<ManagedLinkExtraction> {
  const result: ManagedLinkExtraction = { pages: 0, created: 0, removed: 0, timeline: 0, skipped: 0, remaining: 0 };
  const startMs = Date.now();
  const withMentions = opts.mentions !== false;
  const deadline = withMentions ? await linkPhaseDeadline(engine, opts.sourceId, startMs, opts.timeBudgetMs)
    : opts.timeBudgetMs === undefined ? Infinity : startMs + opts.timeBudgetMs;
  const versionTs = LINK_EXTRACTOR_VERSION_TS;
  const maxPages = opts.maxPages ?? Infinity;
  const done = new Set<string>();
  const attribution = await maintenanceAttribution(engine);
  const derive = async (slug: string, sourceId: string, stamp?: string) => {
    opts.signal?.throwIfAborted();
    done.add(`${sourceId}\0${slug}`);
    const snapshot = await engine.readPageSnapshot(slug, { sourceId });
    if (!snapshot || isQuarantined(snapshot.page.frontmatter)) return;
    const prepared = await prepareAutomaticLinks(engine, slug, snapshot.page, sourceId);
    const outcome = await engine.transaction(async tx => withCoordinatedWrite(tx, [sourceId], async () => {
      await tx.lockPageKeys(prepared.pageKeys);
      const current = await tx.readPageSnapshot(slug, { sourceId });
      if (current?.revision !== snapshot.revision) return null;
      if (!prepared.attendanceComplete) {
        await tx.markPagesAttendanceBlocked([{ slug, source_id: sourceId, revision: current.revision }]);
        return null;
      }
      const written = await prepared.apply(tx);
      if (written.errors) return null;
      const timeline = (await unrecordedCanonicalTimeline(tx, current.page.id, current.page, slug)).map(entry => ({ slug, date: entry.date,
        source: entry.source, summary: entry.summary, detail: entry.detail || '', source_id: sourceId }));
      const added = timeline.length ? await tx.addTimelineEntriesBatch(timeline, { auditSite: 'extract.stale' }) : 0;
      const at = stamp ?? new Date().toISOString();
      await tx.markPagesExtractedBatch([{ slug, source_id: sourceId, extractedAt: at }], at);
      return { ...written, timeline: added };
    }, attribution));
    if (!outcome) { result.skipped++; return; }
    result.pages++;
    result.created += outcome.created;
    result.removed += outcome.removed;
    result.timeline += outcome.timeline;
  };
  const budget = () => result.pages + result.skipped < maxPages && Date.now() < deadline;
  if (opts.slugs?.length && opts.sourceId) {
    for (const slug of new Set(opts.slugs)) { if (!budget()) break; await derive(slug, opts.sourceId); }
  }
  let afterPageId = 0;
  while (budget()) {
    const rows = await engine.listStalePagesForExtraction({ batchSize: 25, afterPageId, sourceId: opts.sourceId, versionTs });
    if (!rows.length) break;
    for (const row of rows) {
      if (!budget()) break;
      afterPageId = row.id;
      if (done.has(`${row.source_id}\0${row.slug}`)) continue;
      await derive(row.slug, row.source_id, row.updated_at.getTime() >= Date.parse(versionTs) ? row.updated_at_iso : versionTs);
    }
  }
  result.remaining = await engine.countStalePagesForExtraction({ sourceId: opts.sourceId, versionTs });
  if (withMentions) {
    result.mentions = await runMentionPass(engine, { sourceId: opts.sourceId, signal: opts.signal,
      ...(opts.timeBudgetMs === undefined ? {} : { deadline: startMs + opts.timeBudgetMs }) });
  }
  return result;
}
