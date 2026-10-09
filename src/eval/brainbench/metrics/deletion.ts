/**
 * BrainBench `deletion` suite (#5575 Part C, CEO-22): `forget --purge`
 * (`purge_fact`) removes a claim from every live store, its receipt accounts
 * for every store that held it, and nothing brings it back.
 *
 * The residual probe is independent of purge's own verification: it scans
 * every text-bearing column of every table in the brain (plus the canonical
 * markdown file) for the claim, so a store the deletion inventory forgot shows
 * up here.
 *
 *   residual_after_purge       rows (and canonical files) still holding a purged claim. Gated = 0.
 *   receipt_completeness       purges whose receipt names every store that held the claim
 *                              before the purge (by table or its inventory adapter). Gated = 1.
 *   resurrection_after_resync  purged claims active again after the fixture's later steps
 *                              (a stale file re-synced, the claim re-remembered). Gated = 0.
 */

import { DELETION_INVENTORY_BY_TABLE } from '../../../core/deletion-inventory.ts';
import type { TrustGoldItem } from '../types.ts';
import type { TrustFixtureRun } from '../trust-scenario.ts';
import type { SuiteScore } from './trust.ts';

export interface DeletionSuiteCounts {
  purge_total: number; residual_rows: number;
  receipt_total: number; receipt_complete: number;
  resurrected: number;
}

export function emptyDeletionCounts(): DeletionSuiteCounts {
  return { purge_total: 0, residual_rows: 0, receipt_total: 0, receipt_complete: 0, resurrected: 0 };
}

/** Tables whose rows are text-free ledgers of the purge itself, or the run's own bookkeeping, never claim text. */
const PROBE_IGNORED = new Set<string>([]);

interface ReceiptStore { store?: unknown; status?: unknown }

function receiptStores(result: Record<string, unknown> | undefined): ReceiptStore[] {
  if (!result) return [];
  const receipt = (result.receipt ?? result) as Record<string, unknown>;
  const lists = [receipt.stores, receipt.residuals].filter(Array.isArray) as ReceiptStore[][];
  return lists.flat();
}

/** The receipt accounts for a table when a store report names the table or its inventory adapter, with a status other than not_present. */
export function receiptAccountsFor(stores: ReceiptStore[], table: string): boolean {
  const adapter = DELETION_INVENTORY_BY_TABLE.get(table)?.reason;
  return stores.some(s => (s.store === table || (adapter && s.store === adapter)) && s.status !== 'not_present');
}

export async function scoreDeletionFixture(run: TrustFixtureRun, items: TrustGoldItem[]): Promise<SuiteScore<DeletionSuiteCounts>> {
  const c = emptyDeletionCounts();
  const failed: string[] = [];
  for (const item of items) {
    const label = `${run.fixtureId}/${item.item_id}`;
    const rec = run.steps.get(item.step)!;
    const fails: string[] = [];
    c.purge_total++;
    c.receipt_total++;
    const claim = item.probe!;
    if (rec.purgedClaim?.toLowerCase() !== claim.toLowerCase()) fails.push(`purge targeted ${JSON.stringify(rec.purgedClaim ?? null)}, not the probe`);
    if (rec.unsettled) fails.push('purge effects did not finish within the settle bound');
    if (!rec.outcome.ok) fails.push(`purge refused or failed (${rec.outcome.code}: ${rec.outcome.message ?? ''})`);

    const residual = Object.entries(rec.postPurgeHits ?? {}).filter(([t]) => !PROBE_IGNORED.has(t));
    const files = rec.postPurgeFiles ?? [];
    const residualRows = residual.reduce((n, [, k]) => n + k, 0) + files.length;
    c.residual_rows += residualRows;
    if (residualRows) fails.push(`residual: ${JSON.stringify(Object.fromEntries(residual))}${files.length ? ` files ${files.join(',')}` : ''}`);

    const stores = receiptStores(rec.outcome.result);
    const missing = Object.keys(rec.prePurgeHits ?? {}).filter(t => !PROBE_IGNORED.has(t) && !receiptAccountsFor(stores, t));
    if (rec.outcome.ok && missing.length === 0 && Object.keys(rec.prePurgeHits ?? {}).length > 0) c.receipt_complete++;
    else fails.push(`receipt missing stores: ${missing.join(', ') || '(no receipt or nothing held the claim before purge)'}`);

    const [active] = await run.engine.executeRaw(
      `SELECT 1 FROM facts WHERE source_id = $1 AND expired_at IS NULL AND lower(fact) = lower($2) LIMIT 1`, [run.sourceId, claim]);
    const [chunk] = await run.engine.executeRaw(
      `SELECT 1 FROM content_chunks ch JOIN pages p ON p.id = ch.page_id WHERE p.source_id = $1 AND p.deleted_at IS NULL
         AND strpos(lower(ch.chunk_text), lower($2)) > 0 LIMIT 1`, [run.sourceId, claim]);
    if (active || chunk) { c.resurrected++; fails.push(`resurrected as ${active ? 'an active fact' : 'a live chunk'}`); }

    if (fails.length) failed.push(`${label}: ${fails.join('; ')}`);
  }
  return { counts: c, gold_total: items.length, gold_failed: failed.length, failed_items: failed };
}

export function deletionMetrics(c: DeletionSuiteCounts): Record<string, number> {
  return {
    residual_after_purge: c.residual_rows,
    receipt_completeness: c.receipt_total > 0 ? c.receipt_complete / c.receipt_total : 1,
    resurrection_after_resync: c.resurrected,
  };
}
