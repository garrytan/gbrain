import type { BrainEngine } from '../engine.ts';
import { LINK_EXTRACTOR_VERSION_TS } from '../link-extraction.ts';
import { prepareAutomaticLinks } from './links-preparation.ts';
import { withCoordinatedWrite } from './context.ts';
import { unrecordedCanonicalTimeline } from './canonical-projections.ts';

export interface ManagedLinkExtraction { pages: number; created: number; removed: number; timeline: number; skipped: number; remaining: number; }

/** `gbrain extract --stale` on a managed brain, locally or inside the PGLite owner. */
export async function runManagedStaleExtraction(engine: BrainEngine, opts: { sourceId?: string; dryRun?: boolean }): Promise<ManagedLinkExtraction> {
  if (!opts.dryRun) return extractManagedStaleLinks(engine, { sourceId: opts.sourceId });
  const remaining = await engine.countStalePagesForExtraction({ sourceId: opts.sourceId, versionTs: LINK_EXTRACTOR_VERSION_TS });
  return { pages: 0, created: 0, removed: 0, timeline: 0, skipped: 0, remaining };
}

/** The `extract --stale` report for a managed brain, in the same text and JSON shapes as the unmanaged sweep. */
export function formatManagedStaleExtraction(result: ManagedLinkExtraction, dryRun: boolean, json: boolean): string {
  if (json) {
    return JSON.stringify(dryRun ? { action: 'extract_stale_dry_run', stale_pages: result.remaining } : {
      action: 'extract_stale_done', links_created: result.created, links_removed: result.removed, timeline_created: result.timeline,
      pages_processed: result.pages, stale_remaining: result.remaining, ...(result.skipped ? { skipped_changed: result.skipped } : {}),
    });
  }
  if (dryRun) return `(dry run) ${result.remaining} page(s) need link/timeline extraction. Run without --dry-run to extract.`;
  return `Extract --stale: ${result.created} link(s) created, ${result.removed} removed, ${result.timeline} timeline entr(ies) from ${result.pages} page(s).` +
    (result.skipped ? ` Skipped ${result.skipped} page(s) edited during extraction or with unresolved attendance; they stay stale.` : '') +
    (result.remaining ? ` ${result.remaining} page(s) remain stale.` : '');
}

/**
 * Derive markdown links with put_page's contract: the page's own derived edges
 * are replaced by what its current text supports, other producers' edges stay.
 * `slugs` (a sync's committed imports) are re-derived regardless of their
 * watermark, because a concurrent sweep may have stamped them mid-sync before
 * their link targets existed; then pages whose watermark is stale follow. Each
 * page's links and watermark commit together, bound to the revision that was
 * read; a page edited meanwhile, or with unresolved attendance, stays stale.
 * Timeline tuples the coordinator projects from the page body but has no stored
 * row for (a page published before timeline projection) are added in the same
 * coordinated transaction, insert-only. This is the one managed extraction
 * path: sync, `extract --stale` (every caller of extractStaleFromDB) and the
 * PGLite owner delegation all run it, in the process that owns the brain.
 */
export async function extractManagedStaleLinks(engine: BrainEngine,
  opts: { sourceId?: string; slugs?: readonly string[]; maxPages?: number; timeBudgetMs?: number; signal?: AbortSignal } = {}): Promise<ManagedLinkExtraction> {
  const result: ManagedLinkExtraction = { pages: 0, created: 0, removed: 0, timeline: 0, skipped: 0, remaining: 0 };
  const deadline = opts.timeBudgetMs === undefined ? Infinity : Date.now() + opts.timeBudgetMs;
  const versionTs = LINK_EXTRACTOR_VERSION_TS;
  const maxPages = opts.maxPages ?? Infinity;
  const done = new Set<string>();
  const derive = async (slug: string, sourceId: string, stamp?: string) => {
    opts.signal?.throwIfAborted();
    done.add(`${sourceId}\0${slug}`);
    const snapshot = await engine.readPageSnapshot(slug, { sourceId });
    if (!snapshot) return;
    const prepared = await prepareAutomaticLinks(engine, slug, snapshot.page, sourceId);
    const outcome = await engine.transaction(async tx => withCoordinatedWrite(tx, [sourceId], async () => {
      await tx.lockPageKeys(prepared.pageKeys);
      const current = await tx.readPageSnapshot(slug, { sourceId });
      if (current?.revision !== snapshot.revision) return null;
      const written = await prepared.apply(tx);
      if (written.errors) return null;
      const timeline = (await unrecordedCanonicalTimeline(tx, current.page.id, current.page, slug)).map(entry => ({ slug, date: entry.date,
        source: entry.source, summary: entry.summary, detail: entry.detail || '', source_id: sourceId }));
      const added = timeline.length ? await tx.addTimelineEntriesBatch(timeline, { auditSite: 'extract.stale' }) : 0;
      const at = stamp ?? new Date().toISOString();
      await tx.markPagesExtractedBatch([{ slug, source_id: sourceId, extractedAt: at }], at);
      return { ...written, timeline: added };
    }));
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
  return result;
}
