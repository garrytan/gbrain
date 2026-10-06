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
import { FACTS_FENCE_BEGIN } from '../facts-fence.ts';

export type FactsReconcileOutcome = 'complete' | 'deferred' | 'invalid' | 'cancelled';

export interface FactsReconcileDrainOpts {
  /** Most pages one run drains beyond its explicit slug list. */
  pageLimit?: number;
  /** Wall-clock budget for drained pages, in ms. */
  budgetMs?: number;
}

export const FACTS_DRAIN_PAGE_LIMIT = 250;
export const FACTS_DRAIN_BUDGET_MS = 60_000;
/** Upper bound on pages one run settles in bulk as having no fence and no fence rows. */
const FACTLESS_SETTLE_LIMIT = 10_000;

const DUE = `(r.page_id IS NULL OR r.reconciled_revision IS DISTINCT FROM p.knowledge_revision)`;
const OWNS_FENCE_ROWS = `EXISTS (SELECT 1 FROM facts f
  WHERE f.source_id = p.source_id AND f.source_markdown_slug = p.slug AND f.row_num IS NOT NULL)`;
const RETRYABLE = `NOT COALESCE(r.outcome = 'invalid' AND r.attempted_revision IS NOT DISTINCT FROM p.knowledge_revision, false)`;

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
  await db.executeRaw(
    `INSERT INTO page_facts_reconcile AS r (page_id, reconciled_revision, reconciled_at, outcome, attempted_revision, attempted_at)
     SELECT p.id, CASE WHEN $3 = 'complete' THEN p.knowledge_revision END, CASE WHEN $3 = 'complete' THEN now() END,
            $3, p.knowledge_revision, now()
       FROM pages p
      WHERE p.source_id = $1 AND p.slug = $2 AND p.deleted_at IS NULL
        AND ($5::boolean OR p.knowledge_revision IS NOT DISTINCT FROM $4::uuid)
     ON CONFLICT (page_id) DO UPDATE SET
       reconciled_revision = CASE WHEN EXCLUDED.outcome = 'complete' THEN EXCLUDED.reconciled_revision ELSE r.reconciled_revision END,
       reconciled_at = CASE WHEN EXCLUDED.outcome = 'complete' THEN EXCLUDED.reconciled_at ELSE r.reconciled_at END,
       outcome = EXCLUDED.outcome,
       attempted_revision = EXCLUDED.attempted_revision,
       attempted_at = EXCLUDED.attempted_at`,
    [sourceId, slug, outcome, revision ?? null, revision === undefined],
  );
}

/**
 * Lock the page row against concurrent writers for the rest of the
 * transaction and confirm it is still the revision the reconcile read.
 * `SELECT … FOR SHARE` fires no trigger and changes nothing.
 */
export async function lockReconcileRevision(tx: BrainEngine, sourceId: string, slug: string, revision: string | null): Promise<boolean> {
  const rows = await tx.executeRaw<{ knowledge_revision: string | null }>(
    `SELECT knowledge_revision FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL FOR SHARE`,
    [sourceId, slug],
  );
  return rows.length === 1 && (rows[0]!.knowledge_revision ?? null) === revision;
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
  const marker = `%${FACTS_FENCE_BEGIN}%`;
  await engine.executeRaw(
    `INSERT INTO page_facts_reconcile AS r (page_id, reconciled_revision, reconciled_at, outcome, attempted_revision, attempted_at)
     SELECT p.id, p.knowledge_revision, now(), 'complete', p.knowledge_revision, now()
       FROM pages p LEFT JOIN page_facts_reconcile r ON r.page_id = p.id
      WHERE p.source_id = $1 AND p.deleted_at IS NULL AND ${DUE}
        AND p.compiled_truth NOT LIKE $2 AND p.timeline NOT LIKE $2
        AND NOT ${OWNS_FENCE_ROWS}
      ORDER BY p.id
      LIMIT $3
     ON CONFLICT (page_id) DO UPDATE SET
       reconciled_revision = EXCLUDED.reconciled_revision, reconciled_at = EXCLUDED.reconciled_at,
       outcome = EXCLUDED.outcome, attempted_revision = EXCLUDED.attempted_revision, attempted_at = EXCLUDED.attempted_at`,
    [sourceId, marker, FACTLESS_SETTLE_LIMIT],
  );
  const rows = await engine.executeRaw<{ slug: string }>(
    `SELECT p.slug FROM pages p LEFT JOIN page_facts_reconcile r ON r.page_id = p.id
      WHERE p.source_id = $1 AND p.deleted_at IS NULL AND ${DUE} AND ${RETRYABLE}
      ORDER BY r.attempted_at ASC NULLS FIRST, p.id ASC
      LIMIT $2`,
    [sourceId, opts.pageLimit ?? FACTS_DRAIN_PAGE_LIMIT],
  );
  return rows.map(r => r.slug);
}

export interface FactsReconcileBacklog {
  /** Live pages with a fence or fence rows whose facts index is behind the page. */
  pending: number;
  /** Pages whose current revision holds a malformed or misplaced fence. */
  invalid: Array<{ source_id: string; slug: string }>;
}

/**
 * Doctor's read of the watermark, unmanaged brains only. The due set is
 * materialized before the body match so a settled brain reads no page body.
 */
export async function readFactsReconcileBacklog(engine: BrainEngine): Promise<FactsReconcileBacklog> {
  const rows = await engine.executeRaw<{ source_id: string; slug: string; invalid: boolean }>(
    `WITH due AS MATERIALIZED (
       SELECT p.id, p.source_id, p.slug, p.knowledge_revision, r.outcome, r.attempted_revision
         FROM pages p LEFT JOIN page_facts_reconcile r ON r.page_id = p.id
        WHERE p.deleted_at IS NULL AND ${DUE}
     )
     SELECT d.source_id, d.slug,
            COALESCE(d.outcome = 'invalid' AND d.attempted_revision IS NOT DISTINCT FROM d.knowledge_revision, false) AS invalid
       FROM due d JOIN pages p ON p.id = d.id
      WHERE p.compiled_truth LIKE $1 OR p.timeline LIKE $1 OR ${OWNS_FENCE_ROWS}
      ORDER BY d.source_id, d.slug`,
    [`%${FACTS_FENCE_BEGIN}%`],
  );
  return {
    pending: rows.filter(r => !r.invalid).length,
    invalid: rows.filter(r => r.invalid).map(r => ({ source_id: r.source_id, slug: r.slug })),
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
