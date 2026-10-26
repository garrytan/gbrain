import type { BrainEngine } from '../engine.ts';
import type { ExtractFactsOpts, ExtractFactsResult } from './extract-facts.ts';
import { type FactsReconcileOutcome, settleFactsReconcile } from '../facts/reconcile-watermark.ts';
import { isAborted } from '../abort-check.ts';
import { runBoundedPool } from './extract-facts-concurrency.ts';

type PageOutcome = FactsReconcileOutcome | 'unchanged' | 'skipped' | 'stop';
type PageState = { revision?: string | null };

export async function selectResumableFactPages(engine: BrainEngine, sourceId: string, completedKey: string): Promise<string[]> {
    const completed = await engine.getConfig(completedKey);
    // Reuse the per-page revision watermark, including no-op pages. A partial
    // walk drops settled revisions from its next candidate set, while failures
    // and edits made during the walk remain due. No page content is stamped.
    const candidates = await engine.executeRaw<{ slug: string }>(`
      SELECT p.slug FROM pages p LEFT JOIN page_facts_reconcile r ON r.page_id = p.id
      WHERE p.source_id = $1 AND p.deleted_at IS NULL AND (
        r.page_id IS NULL OR r.reconciled_revision IS DISTINCT FROM p.knowledge_revision
        OR r.outcome <> 'complete'
        OR (($2::timestamptz IS NULL OR p.updated_at >= $2::timestamptz)
            AND p.updated_at > r.reconciled_at))
        AND NOT COALESCE(r.outcome = 'invalid' AND r.attempted_revision IS NOT DISTINCT FROM p.knowledge_revision, false)
      ORDER BY p.slug`, [sourceId, completed || null]);
    return candidates.map(row => row.slug);
}

export async function resumeFactPages(engine: BrainEngine, slugs: string[], cursorKey: string,
  result: ExtractFactsResult): Promise<string[]> {
    slugs.sort();
    const cursor = await engine.getConfig(cursorKey);
    result.resumed_from = cursor || null;
    if (cursor) {
      const start = slugs.findIndex(slug => slug >= cursor);
      if (start > 0) slugs = [...slugs.slice(start), ...slugs.slice(0, start)];
    }
    result.pages_total = slugs.length;
    result.budget_exhausted = false;
  return slugs;
}

export async function reconcileConcurrentFactPages({ engine, sourceId, result, opts, slugs, clock, startedAt,
  explicit, drainDeadline, watermark, managed, reconcilePage }: {
  engine: BrainEngine; sourceId: string; result: ExtractFactsResult; opts: ExtractFactsOpts; slugs: string[];
  clock: () => number; startedAt: number; explicit: Set<string>; drainDeadline: number;
  watermark: boolean; managed: boolean; reconcilePage: (slug: string, state: PageState) => Promise<PageOutcome>;
}): Promise<{ visited: number; incomplete: boolean }> {
  let incomplete = false;
    console.error(`[extract_facts] source ${sourceId}: concurrency ${result.concurrency}`);
    const failed = (error: unknown, slug: string): PageOutcome => {
      incomplete = true;
      if (isAborted(opts.signal)) return 'stop';
      result.pagesFailed += 1;
      result.warnings.push(`${slug}: FACTS_RECONCILE_FAILED: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}`);
      return 'deferred';
    };
    const pool = await runBoundedPool({
      items: slugs, concurrency: result.concurrency,
      shouldStart: slug => {
        if (clock() - startedAt >= opts.maxMs!) { result.budget_exhausted = true; return false; }
        return !isAborted(opts.signal) && (explicit.has(slug) || Date.now() <= drainDeadline);
      },
      task: async slug => {
        result.pagesScanned += 1;
        const state: PageState = {};
        let outcome: PageOutcome;
        try { outcome = await reconcilePage(slug, state); }
        catch (error) { outcome = failed(error, slug); }
        if (watermark && outcome !== 'complete' && outcome !== 'skipped') {
          const settled = outcome === 'unchanged' ? 'complete' : outcome === 'stop' ? 'cancelled' : outcome;
          await settleFactsReconcile(engine, sourceId, slug, settled, state.revision).catch((error: unknown) => {
            result.warnings.push(`${slug}: facts reconcile watermark not recorded: ${error instanceof Error ? error.message : String(error)}`);
          });
        }
        if (!['complete', 'unchanged', 'skipped'].includes(outcome)) incomplete = true;
        if (managed && (outcome === 'complete' || outcome === 'unchanged')) {
          await settleFactsReconcile(engine, sourceId, slug, 'complete', state.revision);
        }
        return outcome;
      },
      onError: failed,
      stopOn: outcome => outcome === 'stop',
      // Like the sequential loop, every page that was tried moves the cursor on (a failed or deferred page is retried by the next full walk); only a cancelled page stays.
      finished: outcome => outcome !== 'stop' && outcome !== 'cancelled',
    });
    return { visited: pool.visited, incomplete };

}

export async function reconcileFactPages(args: Parameters<typeof reconcileConcurrentFactPages>[0] & { bounded: boolean }): Promise<{ visited: number; incomplete: boolean }> {
  const { engine, sourceId, result, opts, slugs, clock, startedAt, explicit, drainDeadline, watermark, managed, reconcilePage, bounded } = args;
  let visited = 0;
  let incomplete = false;
  if (result.concurrency > 1) return reconcileConcurrentFactPages(args);
  for (; visited < slugs.length; visited++) {
    const slug = slugs[visited];
    if (bounded && clock() - startedAt >= opts.maxMs!) {
      result.budget_exhausted = true;
      break;
    }
    // #1972: bail at the top of the per-page loop on abort. Each page is an
    // independent delete-then-insert commit, so breaking leaves a consistent
    // partial state; the receipt/rollup below still runs with partial counts.
    if (isAborted(opts.signal)) break;
    // Drained pages follow the explicit ones, so the drain budget ends the walk.
    if (!explicit.has(slug) && Date.now() > drainDeadline) break;
    result.pagesScanned += 1;
    const state: PageState = {};
    let outcome: PageOutcome;
    try {
      outcome = await reconcilePage(slug, state);
    } catch (error) {
      if (isAborted(opts.signal)) throw error;
      // One page the database rejects (CHECK/FK violation, malformed input the
      // parser tolerated) must not abort reconciliation for every later page.
      // Its transaction rolled back, so the existing index is preserved.
      result.pagesFailed += 1;
      result.warnings.push(`${slug}: FACTS_RECONCILE_FAILED: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}`);
      outcome = 'deferred';
    }
    if (watermark && outcome !== 'complete' && outcome !== 'skipped') {
      const settled = outcome === 'unchanged' ? 'complete' : outcome === 'stop' ? 'cancelled' : outcome;
      await settleFactsReconcile(engine, sourceId, slug, settled, state.revision).catch((error: unknown) => {
        result.warnings.push(`${slug}: facts reconcile watermark not recorded: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    if (bounded) {
      if (!['complete', 'unchanged', 'skipped'].includes(outcome)) incomplete = true;
      // Managed reconciliation publishes content through its coordinator; this
      // watermark is metadata only and is written after publication finishes.
      if (managed && !opts.dryRun && (outcome === 'complete' || outcome === 'unchanged')) {
        await settleFactsReconcile(engine, sourceId, slug, 'complete', state.revision);
      }
    }
    if (outcome === 'stop') break;
  }

  return { visited, incomplete };
}
