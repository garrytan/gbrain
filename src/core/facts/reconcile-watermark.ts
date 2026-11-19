/**
 * Facts reconcile watermark (#5151) for unmanaged brains.
 *
 * `page_facts_reconcile` records, per page, the `knowledge_revision` the
 * extract_facts phase last reconciled completely, plus the outcome of the
 * latest attempt. It is a side table on purpose: any update to `pages` fires the
 * statement-level generation-clock trigger and the page row triggers, so
 * stamping a watermark on `pages` would churn every reconcile.
 *
 * The cycle's extract_facts phase drains pages whose watermark is behind
 * their revision, so a fence imported by a standalone `gbrain sync` (which
 * the cycle's own no-op sync never reports as changed) still reaches the
 * facts index, and a fence removed from a page still expires its rows.
 *
 * Outcomes: `complete` (the index matches the page, including a no-op),
 * `deferred` (lock held, stale cache, embedding deferral, page changed,
 * database error: retried next run), `invalid` (malformed or misplaced
 * fence: retried only after the page changes) and `cancelled`. The drain
 * orders by last attempt, never-attempted first, so pages that keep
 * deferring rotate to the back and cannot starve the rest.
 */
import type { BrainEngine } from '../engine.ts';
import type { FactsReconcileOutcome } from '../engine-sql/facts-purge.ts';

export type { FactsReconcileOutcome } from '../engine-sql/facts-purge.ts';

export interface FactsReconcileDrainOpts {
  /** Most pages one run drains beyond its explicit slug list. */
  pageLimit?: number;
  /** Wall-clock budget for drained pages, in ms. */
  budgetMs?: number;
}

export const FACTS_DRAIN_PAGE_LIMIT = 250;
export const FACTS_DRAIN_BUDGET_MS = 60_000;
/**
 * Record one page's reconcile outcome. `revision` is the `knowledge_revision`
 * the reconcile read: nothing is recorded when the page has moved on since,
 * so a stale result never marks newer content. `undefined` records against
 * the current revision (an attempt that failed before or while reading).
 */
export async function settleFactsReconcile(
  db: BrainEngine,
  sourceId: string,
  slug: string,
  outcome: FactsReconcileOutcome,
  revision?: string | null,
): Promise<void> {
  await db.settleFactsReconcile(sourceId, slug, outcome, revision);
}

/**
 * Lock the page row against concurrent writers for the rest of the
 * transaction and confirm it is still the revision the reconcile read
 * (engine member; on PGLite and Postgres `SELECT … FOR SHARE`, which fires
 * no trigger and changes nothing).
 */
export async function lockReconcileRevision(tx: BrainEngine, sourceId: string, slug: string, revision: string | null): Promise<boolean> {
  return tx.lockReconcileRevision(sourceId, slug, revision);
}

/**
 * Pages of `sourceId` this run should reconcile beyond its explicit slugs.
 * First settles, in one bounded statement, the due pages that have no fence
 * marker and own no fence rows (their reconcile is a no-op), so the common
 * case never reads those bodies again until they change. Returns the
 * remaining due pages, never-attempted first, then by oldest attempt.
 */
export async function selectFactsReconcileDrain(
  engine: BrainEngine,
  sourceId: string,
  opts: FactsReconcileDrainOpts,
): Promise<string[]> {
  return engine.selectFactsReconcileDrain(sourceId, opts.pageLimit ?? FACTS_DRAIN_PAGE_LIMIT);
}

export interface FactsReconcileBacklog {
  /** Live pages with a fence or fence rows whose facts index is behind the page. */
  pending: number;
  /** Pages whose current revision holds a malformed or misplaced fence. */
  invalid: Array<{ source_id: string; slug: string }>;
  /** Wave B decision #10: due pages stored in segments with no fence rows; the body match cannot read them, so whether they hold a fence is unknown. */
  skipped_segmented?: number;
}

/**
 * Doctor's read of the watermark, unmanaged brains only. The due set is
 * materialized before the body match so a settled brain reads no page body.
 */
export async function readFactsReconcileBacklog(engine: BrainEngine): Promise<FactsReconcileBacklog> {
  const { rows, segmented } = await engine.listFactsReconcileBacklog();
  return {
    pending: rows.filter(r => !r.invalid).length,
    invalid: rows.filter(r => r.invalid).map(r => ({ source_id: r.source_id, slug: r.slug })),
    ...(segmented ? { skipped_segmented: segmented } : {}),
  };
}

/**
 * Doctor's extract_health overlay, applied in place: fence pages whose facts
 * are not indexed yet, and fences the phase cannot read, turn the check into
 * a warning with the command that reconciles every page now.
 */
export function applyFactsReconcileBacklog(
  check: { status: 'ok' | 'warn' | 'fail'; message: string; details?: Record<string, unknown> },
  backlog: FactsReconcileBacklog,
): void {
  if (backlog.pending === 0 && backlog.invalid.length === 0) return;
  const parts: string[] = [];
  if (backlog.pending > 0) {
    parts.push(`${backlog.pending} page(s) with a Facts fence are not reconciled into the facts index yet ` +
      `(the dream cycle drains up to ${FACTS_DRAIN_PAGE_LIMIT} per run; to reconcile every page now run: gbrain dream --phase extract_facts)`);
  }
  if (backlog.invalid.length > 0) {
    const names = backlog.invalid.slice(0, 3).map(p => p.slug).join(', ');
    parts.push(`${backlog.invalid.length} page(s) have a Facts fence extract_facts cannot read (${names}); ` +
      'fix the fence table or move it above the timeline sentinel and save the page');
  }
  if (check.status !== 'fail') check.status = 'warn';
  check.message = `${parts.join('; ')}; ${check.message}`;
  check.details = { ...(check.details ?? {}), facts_reconcile: { pending: backlog.pending, invalid: backlog.invalid.slice(0, 20) } };
}
