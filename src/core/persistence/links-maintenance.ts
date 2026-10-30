import type { BrainEngine } from '../engine.ts';
import { effectiveLinkExtractorWatermark } from '../link-extraction-watermark.ts';
import { isQuarantined } from '../quarantine.ts';
import { prepareAutomaticLinks } from './links-preparation.ts';
import { preparationConfigView } from './config-snapshot.ts';
import { withCoordinatedWrite } from './context.ts';
import { yieldToEventLoop } from './journal.ts';
import { maintenanceAttribution } from './attribution.ts';
import { storedCanonicalTimeline, unrecordedCanonicalTimeline } from './canonical-projections.ts';
import { runMentionPass, type MentionPassResult } from '../mentions/pass.ts';
import { formatMentionSummary, linkPhaseDeadline, mentionJsonFields, previewMentionPass } from '../mentions/stale.ts';
import { plannerStatsForLinkDrain } from '../planner-stats.ts';
import { STALE_TIME_BUDGET_MS, formatStaleCounts, staleExtractionCounts, type StaleExtractionCounts } from '../extraction-lag.ts';
import { ItemRun, type ItemFailure } from '../item-failure.ts';
import type { OperationError } from '../ops/contract.ts';
import { clearLinkExtractionHolds, linkExtractionRetryFix, recordLinkExtractionFailures, type LinkExtractionFailure } from './links-extraction-holds.ts';
export type { LinkExtractionFailure };

export interface ManagedLinkExtraction { pages: number; created: number; removed: number; timeline: number; skipped: number; remaining: number;
  /** The mention pass (absent when the caller ran links only, as sync does). */
  mentions?: MentionPassResult; mention_due?: number; mention_last_pass_at?: string | null;
  /** #6803 (D3): the terminal counts (`gbrain extract --stale` only; sync's tail does not read them). */
  counts?: StaleExtractionCounts;
  /** GBRA-130 A-1 (present when a page failed): pages whose derivation failed this run; the first `LINK_FAILURE_REPORT_LIMIT` are listed. */
  failed?: number; failures?: LinkExtractionFailure[];
  /** Sources an unscoped run stopped because most of their pages failed (the breaker): nothing of theirs was held. */
  systemic?: LinkExtractionSystemic[]; }

export interface LinkExtractionSystemic { source_id: string; code: string; reason: string | null; message: string; fix: OperationError['fix'] }

/** Failures a result lists in full; `failed` counts all of them. */
export const LINK_FAILURE_REPORT_LIMIT = 50;

/**
 * `gbrain extract --stale` on a managed brain, locally or inside the PGLite owner: a plain run stops at the
 * `STALE_TIME_BUDGET_MS` budget and the next resumes, `catchUp` runs until nothing is stale (#6803 D2).
 */
export async function runManagedStaleExtraction(engine: BrainEngine,
  opts: { sourceId?: string; dryRun?: boolean; catchUp?: boolean; timeBudgetMs?: number; counts?: boolean; retryHeld?: boolean }): Promise<ManagedLinkExtraction> {
  const counts = async () => opts.counts === false ? {} : { counts: await staleExtractionCounts(engine, opts.sourceId) };
  if (!opts.dryRun) {
    if (opts.retryHeld) await clearLinkExtractionHolds(engine, opts.sourceId);
    const result = await extractManagedStaleLinks(engine, { sourceId: opts.sourceId, ...(opts.catchUp ? {} : { timeBudgetMs: opts.timeBudgetMs ?? STALE_TIME_BUDGET_MS }) });
    return { ...result, ...await counts() };
  }
  const remaining = await engine.countStalePagesForExtraction({ sourceId: opts.sourceId, versionTs: await effectiveLinkExtractorWatermark(engine), held: 'exclude' });
  const m = await previewMentionPass(engine, opts.sourceId);
  return { pages: 0, created: 0, removed: 0, timeline: 0, skipped: 0, remaining, mention_due: m.due, mention_last_pass_at: m.last_pass_at, ...await counts() };
}

/** The `extract --stale` report for a managed brain, in the same text and JSON shapes as the unmanaged sweep. */
export function formatManagedStaleExtraction(result: ManagedLinkExtraction, dryRun: boolean, json: boolean): string {
  const counts = result.counts;
  if (json) {
    return JSON.stringify({ ...(dryRun ? { action: 'extract_stale_dry_run', stale_pages: result.remaining, mention_due_pages: result.mention_due ?? 0,
      mention_last_pass_at: result.mention_last_pass_at ?? null } : {
      action: 'extract_stale_done', links_created: result.created, links_removed: result.removed, timeline_created: result.timeline,
      pages_processed: result.pages, stale_remaining: result.remaining + (result.mentions?.remaining ?? 0),
      ...(result.skipped ? { skipped_changed: result.skipped } : {}), ...(result.mentions ? mentionJsonFields(result.mentions) : {}),
      ...(result.failed ? { failed: result.failed, failures: result.failures } : {}), ...(result.systemic?.length ? { systemic: result.systemic } : {}),
    }), ...(counts ?? {}) });
  }
  const countsLine = counts ? `\n${formatStaleCounts(counts)}` : '';
  if (dryRun) {
    return `(dry run) ${result.remaining} page(s) need link/timeline extraction; ${result.mention_due ?? 0} page(s) need a mention pass ` +
      `(last pass: ${result.mention_last_pass_at ?? 'never'}). Run without --dry-run to extract.${countsLine}`;
  }
  const mentionLine = result.mentions ? formatMentionSummary(result.mentions) : null;
  return `Extract --stale: ${result.created} link(s) created, ${result.removed} removed, ${result.timeline} timeline entr(ies) from ${result.pages} page(s).` +
    (result.skipped ? ` Skipped ${result.skipped} page(s) edited during extraction or with unresolved attendance; they stay stale.` : '') +
    (result.remaining ? ` ${result.remaining} page(s) remain stale (raw total).` : '') + formatLinkFailures(result) + (mentionLine ? `\n${mentionLine}` : '') + countsLine;
}

/** The failure lines of a run: each listed page with its code and state, then each source the breaker stopped, each with its fix. */
function formatLinkFailures(result: ManagedLinkExtraction): string {
  const lines = (result.failures ?? []).map(f => `\n  ${f.source_id}:${f.slug}: ${f.code} (${f.held ? 'held; fix the page, then run' : f.class === 'content' ? `failed ${f.attempts} run(s); retried by` : 'transient; retried by'} ${f.fix.argv!.join(' ')}): ${f.message}`);
  const head = result.failed ? `\n${result.failed} page(s) failed link extraction and stay stale${result.failed > lines.length ? ` (first ${lines.length} listed)` : ''}; the other pages were derived:` : '';
  const systemic = (result.systemic ?? []).map(s => `\nSource ${s.source_id} stopped (${s.code}, most often ${s.reason}): ${s.message}`);
  return head + lines.join('') + systemic.join('');
}

/** #5984: pages a managed link extraction derives at once on Postgres. */
export const MANAGED_LINK_EXTRACTION_WIDTH = 4;

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
 * Each page yields to the event loop when it finishes: PGLite statements
 * resolve as one microtask chain, so a long drain would otherwise hold every
 * timer and in-process request until its last page.
 */
export async function extractManagedStaleLinks(engine: BrainEngine,
  opts: { sourceId?: string; slugs?: readonly string[]; maxPages?: number; timeBudgetMs?: number; signal?: AbortSignal; mentions?: boolean } = {}): Promise<ManagedLinkExtraction> {
  const result: ManagedLinkExtraction = { pages: 0, created: 0, removed: 0, timeline: 0, skipped: 0, remaining: 0 };
  const startMs = Date.now();
  const withMentions = opts.mentions !== false;
  const deadline = withMentions ? await linkPhaseDeadline(engine, opts.sourceId, startMs, opts.timeBudgetMs)
    : opts.timeBudgetMs === undefined ? Infinity : startMs + opts.timeBudgetMs;
  const maxPages = opts.maxPages ?? Infinity;
  const done = new Set<string>();
  const attribution = await maintenanceAttribution(engine);
  // #5984: every page's link preparation reads the same config; one read answers them for this run. The watermark
  // comes from the same read, so a page is stamped against the line-grammar generation it was prepared under;
  // publication refuses it if the generation moved since (derived-links.ts), and it stays stale.
  const settings = await preparationConfigView(engine);
  const versionTs = await effectiveLinkExtractorWatermark(settings);
  const derive = async (slug: string, sourceId: string, stamp: string | undefined, read: { revision: string | null }) => {
    done.add(`${sourceId}\0${slug}`);
    // A segmented body stays unread: links and the canonical timeline read it block by block, before the transaction.
    const snapshot = await engine.readPageSnapshot(slug, { sourceId });
    if (!snapshot || isQuarantined(snapshot.page.frontmatter)) return;
    read.revision = snapshot.revision;
    const prepared = await prepareAutomaticLinks(settings, slug, snapshot.page, sourceId);
    const canonical = await storedCanonicalTimeline(engine, snapshot.page, slug);
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
      const timeline = (await unrecordedCanonicalTimeline(tx, current.page.id, canonical, slug)).map(entry => ({ slug, date: entry.date,
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
  let started = 0;
  const budget = () => started < maxPages && Date.now() < deadline;
  // #5984: on Postgres several pages derive at once, each in its own transaction (page guards lock in sorted
  // order, so they cannot deadlock); a page's links depend only on committed pages.
  // GBRA-130 A-1: a page whose derivation fails is recorded (one ItemRun per source) and the cursor moves past it; a
  // run-scoped failure stops every worker and is rethrown once they settle. When most of a source's pages fail, its
  // breaker trips: a run scoped to that source stops with `item_failures_systemic`, a brain-wide run skips the rest of
  // that source and reports it in `systemic`. Nothing of a tripped source is recorded.
  const width = engine.kind === 'postgres' ? MANAGED_LINK_EXTRACTION_WIDTH : 1;
  const runs = new Map<string, ItemRun>();
  const failed: Array<ItemFailure & { slug: string; source_id: string; revision: string | null; order: number }> = [];
  let taken = 0;
  const tripped = new Map<string, OperationError>();
  let stop: { error: unknown } | null = null;
  const each = async (items: ReadonlyArray<{ slug: string; sourceId: string; stamp?: string }>) => {
    let next = 0;
    const settled = await Promise.allSettled(Array.from({ length: Math.min(width, items.length) }, async () => {
      while (!stop && next < items.length && budget()) {
        const { slug, sourceId, stamp } = items[next++]!;
        const order = taken++;
        if (tripped.has(sourceId)) continue;
        try { opts.signal?.throwIfAborted(); } catch (error) { stop ??= { error }; break; }
        started++;
        await plannerTick(started);
        const run = runs.get(sourceId) ?? runs.set(sourceId, new ItemRun('links.extract_stale')).get(sourceId)!;
        const read = { revision: null as string | null };
        try {
          await derive(slug, sourceId, stamp, read);
          run.succeed();
          await yieldToEventLoop();
        } catch (error) {
          try { failed.push({ ...run.fail(`${sourceId}:${slug}`, error), slug, source_id: sourceId, revision: read.revision, order }); } catch (stopped) {
            if (stopped !== error && !opts.sourceId) tripped.set(sourceId, stopped as OperationError);
            else stop ??= { error: stopped };
          }
        }
      }
    }));
    const rejected = settled.find(outcome => outcome.status === 'rejected');
    if (rejected) throw (rejected as PromiseRejectedResult).reason;
    if (stop) throw stop.error;
  };
  const plannerTick = await plannerStatsForLinkDrain(engine, async () =>
    Math.min(maxPages, await engine.countStalePagesForExtraction({ sourceId: opts.sourceId, versionTs, held: 'exclude' })));
  if (opts.slugs?.length && opts.sourceId) await each([...new Set(opts.slugs)].map(slug => ({ slug, sourceId: opts.sourceId! })));
  let afterPageId = 0;
  while (budget()) {
    const rows = await engine.listStalePagesForExtraction({ batchSize: 25, afterPageId, sourceId: opts.sourceId, versionTs, held: 'exclude' });
    if (!rows.length) break;
    afterPageId = rows[rows.length - 1]!.id;
    await each(rows.filter(row => !done.has(`${row.source_id}\0${row.slug}`)).map(row => ({ slug: row.slug, sourceId: row.source_id,
      stamp: row.updated_at.getTime() >= Date.parse(versionTs) ? row.updated_at_iso : versionTs })));
  }
  // Concurrent Postgres workers fail in completion order; report failures in drain order, as PGLite's single worker does.
  failed.sort((a, b) => a.order - b.order);
  // Holds are counted only for sources whose failures look like their pages' own (ItemRun.systemic).
  const recorded = await recordLinkExtractionFailures(engine, versionTs,
    failed.filter(f => f.class === 'content' && !tripped.has(f.source_id) && !runs.get(f.source_id)!.systemic()));
  if (failed.length) {
    result.failed = failed.length;
    result.failures = failed.slice(0, LINK_FAILURE_REPORT_LIMIT).map(f => {
      const count = recorded.get(`${f.source_id}\0${f.slug}`);
      return { slug: f.slug, source_id: f.source_id, code: f.code, class: f.class, message: f.message, attempts: count?.attempts ?? 0,
        held: count?.held ?? false, fix: linkExtractionRetryFix(f.source_id, count?.held ?? false) };
    });
  }
  if (tripped.size) result.systemic = [...tripped].map(([sourceId, error]) => ({ source_id: sourceId, code: error.code, reason: error.reason ?? null,
    message: error.message, fix: linkExtractionRetryFix(sourceId, false) }));
  result.remaining = await engine.countStalePagesForExtraction({ sourceId: opts.sourceId, versionTs, held: 'exclude' });
  if (withMentions) {
    result.mentions = await runMentionPass(engine, { sourceId: opts.sourceId, signal: opts.signal,
      ...(opts.timeBudgetMs === undefined ? {} : { deadline: startMs + opts.timeBudgetMs }) });
  }
  return result;
}
