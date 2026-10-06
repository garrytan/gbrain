/**
 * `gbrain extract timeline --source db` (#5904 probe, E28).
 *
 * `timeline_entries` is a guarded table: on a managed brain (every fresh
 * `gbrain init` brain is one) a raw batch insert is refused by
 * `managed_writer_guard`. Managed brains therefore publish each page that
 * needs a change as one database-only maintenance request
 * (`managed_maintenance_timeline_extract`, owner-checked by
 * `maintenancePreflight`): under the page lock, bound to the revision that
 * was read, the rows an earlier version produced and the current text no
 * longer does are retracted and the timeline tuples the canonical body
 * projects with no stored row are inserted. A page with nothing to change
 * admits no request. Unmanaged brains keep the batched raw insert.
 *
 * A refused write is reported as what it is: nothing was written and the
 * timeline rows import already stored are untouched. Refusals are counted
 * apart from written rows and make the command exit non-zero.
 */
import type { BrainEngine, TimelineBatchInput } from '../core/engine.ts';
import type { Page, PageType } from '../core/types.ts';
import { parseTimelineEntries, deriveTimelineAnchor } from '../core/link-extraction.ts';
import { retractRemovedTimelineEntries } from '../core/timeline-extract.ts';
import { managedPersistenceEnabled } from '../core/persistence/ownership.ts';
import { maintenanceTransaction } from '../core/persistence/attribution.ts';
import { unrecordedCanonicalTimeline } from '../core/persistence/canonical-projections.ts';
import { maintenancePreflight, submitDatabaseMaintenanceIntent, type MaintenanceAuthority } from '../core/persistence/prepared-maintenance.ts';
import { authorizeWrite } from '../core/persistence/authority.ts';
import { getWriteRequest } from '../core/persistence/journal.ts';
import { isTerminal, type WriteRequest } from '../core/persistence/model.ts';
import { digest } from '../core/persistence/digest.ts';
import type { PreparedMutation } from '../core/persistence/coordinator.ts';
import { OperationError, opError } from '../core/ops/contract.ts';
import { readFix } from '../core/ops/op-fix.ts';
import { createProgress } from '../core/progress.ts';
import { importAnalyzeEveryPages, maybeRefreshPlannerStats } from '../core/planner-stats.ts';
import { getCliOptions, cliOptsToProgressOptions } from '../core/cli-options.ts';
import { filterRefsSince } from './extract.ts';

const BATCH_SIZE = 100;
export const TIMELINE_EXTRACT_INTENT = 'managed_maintenance_timeline_extract';
export const TIMELINE_REFUSAL_DOCS = 'docs/guides/write-refusals.md#extract-timeline-refused';

export interface TimelineDbResult {
  created: number;
  pages: number;
  /** Pages (managed) or rows (unmanaged batches) whose write was refused. */
  refused: number;
  /** Managed pages edited during the run; they keep their stored rows and are picked up by the next run. */
  skipped: number;
  /** Managed pages whose request was accepted but has not committed yet; rerunning resumes the same request. */
  pending: number;
  refusal_codes: string[];
}

export interface TimelineDbOptions {
  dryRun: boolean;
  jsonMode: boolean;
  quiet?: boolean;
  typeFilter?: PageType;
  since?: string;
  sourceIdFilter?: string;
  inferDates?: boolean;
  /** Restrict the walk to these slugs (requires sourceIdFilter). */
  slugs?: readonly string[];
}

/**
 * The refusal reason: the error's own code, unless it is the coordinator's
 * generic `storage_error`, whose message carries the database refusal
 * (`writer_coordinator_required: ...`) that names the real reason.
 */
export function refusalCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown })?.code;
  const own = typeof code === 'string' && /^[a-z][a-z0-9_]+$/.test(code) ? code : null;
  if (own && own !== 'storage_error') return own;
  return /(?:^|[\s(])([a-z][a-z0-9]*_[a-z0-9_]+):/.exec(message)?.[1] ?? own ?? 'storage_error';
}

function reportRefusal(opts: TimelineDbOptions, code: string, where: string, message: string): void {
  if (opts.jsonMode) {
    process.stderr.write(JSON.stringify({ event: 'timeline_refused', code, where, error: message }) + '\n');
  } else {
    console.error(`  refused: ${code}; nothing written; existing timeline rows are untouched (${where})`);
  }
}

function anchorFor(page: Page, slug: string) {
  return deriveTimelineAnchor({ slug, title: page.title, effectiveDate: page.effective_date, effectiveDateSource: page.effective_date_source });
}

async function walkRefs(engine: BrainEngine, opts: TimelineDbOptions) {
  const all = opts.sourceIdFilter
    ? (await engine.listAllPageRefs()).filter(r => r.source_id === opts.sourceIdFilter)
    : await engine.listAllPageRefs();
  const wanted = opts.slugs ? new Set(opts.slugs) : null;
  return filterRefsSince(wanted ? all.filter(r => wanted.has(r.slug)) : all, opts.since);
}

/**
 * Walk the selected pages from the database and add their timeline rows.
 * Managed brains publish per page through the coordinator; unmanaged brains
 * batch raw inserts (`ON CONFLICT DO NOTHING`).
 */
export async function extractTimelineFromDB(engine: BrainEngine, opts: TimelineDbOptions): Promise<TimelineDbResult> {
  const refs = await walkRefs(engine, opts);
  const result: TimelineDbResult = { created: 0, pages: 0, refused: 0, skipped: 0, pending: 0, refusal_codes: [] };
  const authorities = new Map<string, Promise<MaintenanceAuthority>>();
  const authorityFor = (sourceId: string) => {
    if (!authorities.has(sourceId)) authorities.set(sourceId, maintenancePreflight(engine, sourceId).then(a => a!));
    return authorities.get(sourceId)!;
  };
  const codes = new Set<string>();
  const progress = createProgress(cliOptsToProgressOptions(getCliOptions()));
  progress.start('extract.timeline_db', refs.length);
  const managed = !opts.dryRun && await managedPersistenceEnabled(engine);
  const dryRunSeen = opts.dryRun ? new Set<string>() : null;
  const batch: TimelineBatchInput[] = [];
  // PGLite has no autovacuum: a walk that grows timeline_entries from empty
  // re-plans its per-page reads against stale statistics and slows with
  // every row, so it refreshes them on the bulk-import cadence.
  const analyzeEvery = opts.dryRun ? 0 : await importAnalyzeEveryPages(engine);
  let walked = 0;

  async function flush() {
    if (batch.length === 0) return;
    const snapshot = batch.slice();
    batch.length = 0;
    try {
      result.created += await maintenanceTransaction(engine, tx => tx.addTimelineEntriesBatch(snapshot, { auditSite: 'extract.timeline_db' }));
    } catch (e) {
      const code = refusalCode(e);
      codes.add(code);
      result.refused += snapshot.length;
      reportRefusal(opts, code, `batch of ${snapshot.length} rows`, e instanceof Error ? e.message : String(e));
    }
  }

  for (const { slug, source_id } of refs) {
    if (analyzeEvery > 0 && walked > 0 && walked % analyzeEvery === 0) {
      await flush();
      await maybeRefreshPlannerStats(engine, 'extract', { throttle: false }).catch(() => undefined);
    }
    walked++;
    if (managed) {
      try {
        const outcome = await publishPageTimeline(engine, await authorityFor(source_id), slug, source_id, opts);
        if (outcome === 'skipped') result.skipped++;
        else if (outcome === 'pending') result.pending++;
        else if (outcome !== null) { result.created += outcome; result.pages++; }
      } catch (e) {
        const code = refusalCode(e);
        codes.add(code);
        result.refused++;
        reportRefusal(opts, code, `${source_id}:${slug}`, e instanceof Error ? e.message : String(e));
      }
      progress.tick(1);
      continue;
    }

    const page = await engine.getPage(slug, { sourceId: source_id });
    if (!page) continue;
    if (opts.typeFilter && page.type !== opts.typeFilter) continue;
    const fullContent = page.compiled_truth + '\n' + page.timeline;
    if (!opts.dryRun) await retractRemovedTimelineEntries(engine, slug, source_id, fullContent);
    let entries = parseTimelineEntries(fullContent);
    // --infer-dates: pages with no in-body timeline line but a trustworthy
    // content date (frontmatter / filename) get one anchor entry at that date.
    if (entries.length === 0 && opts.inferDates) {
      const anchor = anchorFor(page, slug);
      if (anchor) entries = [anchor];
    }
    for (const entry of entries) {
      if (dryRunSeen) {
        const key = `${source_id}::${slug}::${entry.date}::${entry.summary}`;
        if (dryRunSeen.has(key)) continue;
        dryRunSeen.add(key);
        if (opts.jsonMode) {
          process.stdout.write(JSON.stringify({
            action: 'add_timeline', slug, source_id, date: entry.date,
            summary: entry.summary, ...(entry.detail ? { detail: entry.detail } : {}),
          }) + '\n');
        } else if (!opts.quiet) {
          console.log(`  ${slug}: ${entry.date} — ${entry.summary}`);
        }
        result.created++;
      } else {
        batch.push({ slug, date: entry.date, source: entry.source, summary: entry.summary, detail: entry.detail || '', source_id });
        if (batch.length >= BATCH_SIZE) await flush();
      }
    }
    result.pages++;
    progress.tick(1);
  }
  await flush();
  progress.finish();
  result.refusal_codes = [...codes];

  if (!opts.jsonMode && !opts.quiet) {
    const label = opts.dryRun ? '(dry run) would create' : 'created';
    console.log(`Timeline: ${label} ${result.created} entries from ${result.pages} pages (db source)` +
      (result.skipped ? `; ${result.skipped} page(s) changed during the run were left for the next run` : '') +
      (result.pending ? `; ${result.pending} page(s) accepted but still pending (writer busy); rerun the same command to confirm` : ''));
  }
  if (result.refused > 0) {
    const unit = managed ? 'page(s)' : 'row(s)';
    console.error(
      `[extract timeline] refused: ${result.refusal_codes.join(', ')}; ${result.refused} ${unit} not written, ${result.created} written. ` +
      `Existing timeline rows are untouched (import already stored the rows of each page it wrote). ` +
      `Recovery: gbrain extract --stale${opts.sourceIdFilter ? ` --source-id ${opts.sourceIdFilter}` : ''}. Docs: ${TIMELINE_REFUSAL_DOCS}`,
    );
  }
  return result;
}

/** The timeline change one page needs: removed rows to retract and canonical tuples (or an inferred anchor) to insert. */
async function plannedTimeline(engine: BrainEngine, page: Page, slug: string, sourceId: string, inferDates: boolean) {
  const fullContent = page.compiled_truth + '\n' + page.timeline;
  const removed = await retractRemovedTimelineEntries(engine, slug, sourceId, fullContent, { dryRun: true });
  let entries: Array<{ date: string; source?: string; summary: string; detail?: string }> = await unrecordedCanonicalTimeline(engine, page.id, page, slug);
  if (entries.length === 0 && inferDates && parseTimelineEntries(fullContent).length === 0) {
    const anchor = anchorFor(page, slug);
    const [stored] = anchor ? await engine.executeRaw<{ n: number }>(
      'SELECT count(*)::int AS n FROM timeline_entries WHERE page_id=$1 AND event_page_id IS NULL', [page.id]) : [{ n: 1 }];
    if (anchor && !stored?.n) entries = [anchor];
  }
  return { fullContent, removed: removed.length, entries };
}

/** Under the coordinator's page lock: retract removed rows, insert the planned tuples. */
async function writePageTimeline(tx: BrainEngine, page: Page, slug: string, sourceId: string, inferDates: boolean): Promise<number> {
  const plan = await plannedTimeline(tx, page, slug, sourceId, inferDates);
  if (plan.removed) await retractRemovedTimelineEntries(tx, slug, sourceId, plan.fullContent);
  if (!plan.entries.length) return 0;
  return tx.addTimelineEntriesBatch(plan.entries.map(entry => ({ slug, date: entry.date, source: entry.source,
    summary: entry.summary, detail: entry.detail || '', source_id: sourceId })), { auditSite: 'extract.timeline_db' });
}

/**
 * One page on a managed brain: null when the page is missing or filtered out,
 * 0 when nothing changes (no request admitted), else the rows the committed
 * request added. The request id is bound to the page revision, so a rerun
 * replays an accepted request instead of admitting a second one.
 */
async function publishPageTimeline(engine: BrainEngine, authority: MaintenanceAuthority, slug: string, sourceId: string,
  opts: TimelineDbOptions): Promise<number | null | 'skipped' | 'pending'> {
  const snapshot = await engine.readPageSnapshot(slug, { sourceId });
  if (!snapshot || (opts.typeFilter && snapshot.page.type !== opts.typeFilter)) return null;
  const plan = await plannedTimeline(engine, snapshot.page, slug, sourceId, opts.inferDates === true);
  if (!plan.removed && !plan.entries.length) return 0;
  for (let attempt = 0; ; attempt++) {
    const h = digest(['extract-timeline-db-v1', sourceId, slug, snapshot.revision, attempt]);
    const requestId = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
    const prior = await getWriteRequest(engine, authority.writer.principal, requestId);
    if (prior && isTerminal(prior) && prior.state !== 'committed') continue;
    try {
      const receipt = await submitDatabaseMaintenanceIntent(engine, authority, slug,
        { kind: TIMELINE_EXTRACT_INTENT, expected_revision: snapshot.revision, infer_dates: opts.inferDates === true }, requestId);
      return Number(receipt.added ?? 0);
    } catch (error) {
      if (error instanceof OperationError && ['revision_conflict', 'page_not_found', 'page_identity_changed'].includes(error.code)) return 'skipped';
      if (error instanceof OperationError && error.code === 'write_pending') return 'pending';
      throw error;
    }
  }
}

/**
 * One page's timeline on a managed brain, through the coordinator (the serve
 * sweep's path): rows added, 0 when nothing changes, or 'unsettled' when the
 * page changed mid-run or its request is still pending (retry next time).
 */
export async function publishManagedPageTimeline(engine: BrainEngine, slug: string, sourceId: string): Promise<number | 'unsettled'> {
  const authority = await maintenancePreflight(engine, sourceId);
  if (!authority) throw opError('writer_coordinator_required', 'This brain is not managed; write the timeline batch directly.',
    `Source ${sourceId} has no managed writer, so there is no coordinator to publish through.`);
  const outcome = await publishPageTimeline(engine, authority, slug, sourceId, { dryRun: false, jsonMode: false });
  return outcome === 'skipped' || outcome === 'pending' ? 'unsettled' : outcome ?? 0;
}

/** Preparer for `managed_maintenance_timeline_extract`: a database-only publication on the page key. */
function timelinePageChanged(row: WriteRequest, message: string): OperationError {
  return opError('page_identity_changed', message,
    `Page ${row.slug} in source ${row.source_id} changed before its queued timeline extraction ran, so this page was skipped. Read the page that holds the slug now; gbrain extract timeline --source db --source-id ${row.source_id} extracts it again under a new request.`,
    { fix: readFix(`Shows which page holds ${row.slug} now and its revision.`, { argv: ['gbrain', 'get', '--source', row.source_id, '--', row.slug], mcp: { tool: 'get_page', arguments: { slug: row.slug, source_id: row.source_id } } }) });
}

export async function prepareTimelineExtract(engine: BrainEngine, row: WriteRequest): Promise<PreparedMutation> {
  const snapshot = await engine.readPageSnapshot(row.slug, { sourceId: row.source_id });
  if (!snapshot || snapshot.page.id !== Number(row.page_id)) throw timelinePageChanged(row, 'The page was deleted or replaced before its timeline was extracted.');
  await authorizeWrite(engine, row.authority, 'submit_job', row.slug);
  const inferDates = (row.intent as { infer_dates?: unknown } | null)?.infer_dates === true;
  return { observedRevision: snapshot.revision, noop: true,
    validate: async tx => { await authorizeWrite(tx, row.authority, 'submit_job', row.slug); },
    apply: async tx => {
      const current = await tx.readPageSnapshot(row.slug, { sourceId: row.source_id });
      if (!current) throw timelinePageChanged(row, 'The page disappeared before its timeline was extracted.');
      return { status: 'completed', added: await writePageTimeline(tx, current.page, row.slug, row.source_id, inferDates) };
    } };
}
