/**
 * Checkout-less extract phase (#5875).
 *
 * A cycle with no on-disk checkout (a connector source such as Google, or a
 * Postgres brain run without `--dir`) has no files to walk, but its pages can
 * still be stale for link/timeline extraction: connector publications write
 * pages without derived links. This runner drains that backlog from the
 * database with the same bounded, source-scoped `extractStaleFromDB` call the
 * file-backed extract phase runs after its walk. On a managed brain
 * `extractStaleFromDB` routes to `extractManagedStaleLinks`, the coordinated
 * extraction path, so no guarded table is written outside the coordinator.
 *
 * Scope: a per-source cycle drains only its source; a brain-wide cycle (no
 * source id) drains every source inside the same budget. Throws propagate to
 * the cycle's phase containment, which records a `fail` result. Pages the
 * drain could not derive (GBRA-130 A-1) make the phase `warn`, naming the
 * first page, its code and the fix (`staleDrainFailures`, shared with the
 * file-backed extract phase).
 */
import type { BrainEngine } from '../engine.ts';
import type { PhaseResult } from '../cycle.ts';
import { extractStaleFromDB } from '../../commands/extract.ts';
import type { LinkExtractionFailure } from '../persistence/links-extraction-holds.ts';
import type { LinkExtractionSystemic } from '../persistence/links-maintenance.ts';

/**
 * GBRA-130 A-1: a stale drain that left pages underived (`linkFailed`) or stopped a source (`linkSystemic`) as
 * phase details and the summary note that makes the extract phase warn; null when every attempted page derived.
 */
export function staleDrainFailures(drained: { linkFailed?: number; linkFailures?: LinkExtractionFailure[]; linkSystemic?: LinkExtractionSystemic[] }):
  { details: Record<string, unknown>; note: string } | null {
  const systemic = drained.linkSystemic ?? [];
  if (!drained.linkFailed && !systemic.length) return null;
  const failed = (drained.linkFailures ?? []).map(f => ({ slug: f.slug, source_id: f.source_id, code: f.code, held: f.held }));
  const first = drained.linkFailures?.[0];
  const notes = [
    ...(first ? [`${drained.linkFailed} page(s) failed link extraction (first: ${first.source_id}:${first.slug}, ${first.code}${first.held ? ', held' : ''}; fix: ${first.fix.argv!.join(' ')})`] : []),
    ...systemic.map(s => `source ${s.source_id} stopped (${s.code}, most often ${s.reason}; fix the shared cause, then run ${s.fix?.argv?.join(' ')})`),
  ];
  return { details: { stale_drain_failed: failed, ...(drained.linkFailed ? { stale_drain_failed_total: drained.linkFailed } : {}),
    ...(systemic.length ? { stale_drain_systemic: systemic.map(s => ({ source_id: s.source_id, code: s.code, reason: s.reason })) } : {}) }, note: `; ${notes.join('; ')}` };
}

export async function runPhaseExtractDatabaseOnly(
  engine: BrainEngine,
  opts: { dryRun: boolean; sourceId?: string; timeBudgetMs: number },
): Promise<PhaseResult> {
  if (opts.dryRun) {
    return {
      phase: 'extract',
      status: 'skipped',
      duration_ms: 0,
      summary: 'dry-run: extract phase skipped (no dry-run mode yet)',
      details: { dryRun: true, reason: 'no_dry_run_support', database_only: true },
    };
  }
  const drained = await extractStaleFromDB(engine, {
    dryRun: false,
    jsonMode: false,
    quiet: true,
    sourceIdFilter: opts.sourceId,
    catchUp: false,
    timeBudgetMs: opts.timeBudgetMs,
  });
  const failures = staleDrainFailures(drained);
  return {
    phase: 'extract',
    status: failures ? 'warn' : 'ok',
    duration_ms: 0,
    summary: `${drained.linksCreated} link(s), ${drained.timelineCreated} timeline entries `
      + `(database-only: ${drained.pagesProcessed} stale page(s) drained, ${drained.staleRemaining} remaining)${failures?.note ?? ''}`,
    details: {
      database_only: true,
      linksCreated: drained.linksCreated,
      timelineCreated: drained.timelineCreated,
      pages_processed: 0,
      stale_pages_drained: drained.pagesProcessed,
      stale_links_created: drained.linksCreated,
      stale_timeline_created: drained.timelineCreated,
      staleRemaining: drained.staleRemaining,
      ...(drained.staleRemaining > 0 ? { stale_backlog: true } : {}),
      ...failures?.details,
    },
  };
}
