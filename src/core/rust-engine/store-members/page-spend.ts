/**
 * The page embedding lease, the per-page spend ledgers and the reads around them (engine-sql/page-spend.ts), served by
 * gbrain-store `jobs::page_lease` (the lease rows, in the cycle-lock keyspace) and `page_body::page_spend` (the
 * ledgers): rust/docs/store/page_spend.md. Each store write is one store transaction; inside `transaction(fn)` the
 * members run on the transaction's handle, whose single writer stands in for PGLite's row lock.
 *
 * The store keeps one vector column, `embedding`; a member asked for another column refuses.
 *
 * Export only BrainEngine members from this file, each a `StoreMember` named after the member it serves (see tags.ts):
 * index.ts spreads the whole module into STORE_MEMBERS, so every export is served.
 */
import type { BudgetLimitedPagesOpts, PageBudgetReport, PageSizeStateRow, PageSpendLedger, PageSpendLedgerRow,
  PageSpendReservationWrite } from '../../engine-sql/page-spend.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';

/** The one vector column the store keeps; a member asked for another refuses. */
function storeColumn(member: string, column: string): void {
  if (column !== 'embedding') refuseMember(member, `column ${column}`);
}

export const takePageEmbeddingLease: StoreMember<[id: string, holder: { pid: number; host: string }, ttlMinutes: number, token: string], boolean> =
  (brain, id, holder, ttlMinutes, token) =>
    storeCall({ member: 'takePageEmbeddingLease' }, () => brain.takePageEmbeddingLease(id, { pid: holder.pid, host: holder.host }, ttlMinutes, token));

export const renewPageEmbeddingLease: StoreMember<[id: string, token: string, ttlMinutes: number], boolean> = (brain, id, token, ttlMinutes) =>
  storeCall({ member: 'renewPageEmbeddingLease' }, () => brain.renewPageEmbeddingLease(id, token, ttlMinutes));

export const releasePageEmbeddingLease: StoreMember<[id: string, token: string], void> = async (brain, id, token) => {
  await storeCall({ member: 'releasePageEmbeddingLease' }, () => brain.releasePageEmbeddingLease(id, token));
};

export const listVectorlessChunkIndexes: StoreMember<[pageId: number, column: string], number[]> = async (brain, pageId, column) => {
  storeColumn('listVectorlessChunkIndexes', column);
  return storeCall({ member: 'listVectorlessChunkIndexes' }, () => brain.listVectorlessChunkIndexes(pageId));
};

export const readPageEmbeddingHolds: StoreMember<[pageId: number], { marker: string | null; state: string | null; reason: string | null } | null> =
  (brain, pageId) => storeCall({ member: 'readPageEmbeddingHolds' }, () => brain.readPageEmbeddingHolds(pageId));

export const writePageEmbeddingHold: StoreMember<[pageId: number, reason: string, mode: 'replace' | 'if_absent'], void> =
  async (brain, pageId, reason, mode) => {
    await storeCall({ member: 'writePageEmbeddingHold' }, () => brain.writePageEmbeddingHold(pageId, reason, mode));
  };

export const openPageEmbeddingHold: StoreMember<[pageId: number], void> = async (brain, pageId) => {
  await storeCall({ member: 'openPageEmbeddingHold' }, () => brain.openPageEmbeddingHold(pageId));
};

export const lockPageSpendLedger: StoreMember<[ledger: PageSpendLedger], PageSpendLedgerRow | null> = (brain, ledger) =>
  storeCall({ member: 'lockPageSpendLedger' }, () => brain.lockPageSpendLedger({ ...ledger }));

export const writePageSpendReservation: StoreMember<[ledger: PageSpendLedger, write: PageSpendReservationWrite], string | null> =
  (brain, ledger, write) => storeCall({ member: 'writePageSpendReservation' }, () => brain.writePageSpendReservation({ ...ledger }, {
    spent: write.spent, reserved: write.reserved, keepWindow: write.keepWindow, signature: write.signature ?? null,
    plan: write.plan ? { state: write.plan.state, reason: write.plan.reason, capUsd: write.plan.capUsd } : null,
  }));

export const settlePageSpendReservation: StoreMember<[ledger: PageSpendLedger, window: string, reservedUsd: number, bookedUsd: number, unpriced: number], void> =
  async (brain, ledger, window, reservedUsd, bookedUsd, unpriced) => {
    await storeCall({ member: 'settlePageSpendReservation' }, () =>
      brain.settlePageSpendReservation({ ...ledger }, { window, reservedUsd, bookedUsd: Math.max(0, bookedUsd), unpriced: Math.trunc(unpriced) }));
  };

export const listBudgetLimitedPageRows: StoreMember<[column: string, opts: BudgetLimitedPagesOpts], PageBudgetReport[]> = async (brain, column, opts) => {
  storeColumn('listBudgetLimitedPageRows', column);
  return storeCall({ member: 'listBudgetLimitedPageRows', sourceId: opts.sourceId }, () =>
    brain.listBudgetLimitedPageRows({ state: opts.state ?? null, sourceId: opts.sourceId || null, limit: opts.limit }));
};

export const readPageSizeStateRows: StoreMember<[sourceId: string, slugs: readonly string[] | null], PageSizeStateRow[]> = (brain, sourceId, slugs) =>
  storeCall({ member: 'readPageSizeStateRows', sourceId }, () => brain.readPageSizeStateRows(sourceId, slugs ? [...slugs] : null));
