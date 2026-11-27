/**
 * The daily budget ledger's writes (BrainEngine reclaimBudgetReservations, reserveBudgetReservation,
 * dispatchBudgetReservation, settleBudgetReservation, releaseBudgetReservation; engine-sql/budget-ledger-writes.ts) on the
 * store's ledger (gbrain-store budget_ledger.rs: the budget_ledger and budget_reservations records, each write one store
 * write). The day read is readBudgetLedgerDay (store-members/fence-census.ts), over the same records, so the paid-call
 * protocol (budget/daily-ledger.ts) reserves, settles and reads a day the same way on every engine.
 * rust/docs/store/repair-fences.md.
 */
import type { BudgetLedgerKey, BudgetReservationSpec, BudgetSettleRow } from '../../engine-sql/budget-ledger-writes.ts';
import { storeCall, type StoreMember } from './common.ts';

export const reclaimBudgetReservations: StoreMember<[key: BudgetLedgerKey, nowIso: string], { released: number; uncertain: number }> = async (brain, key, nowIso) => {
  const row = await storeCall({ member: 'reclaimBudgetReservations' }, () => brain.reclaimBudgetReservations(key, nowIso)) as { released: number; uncertain: number };
  return { released: Number(row.released), uncertain: Number(row.uncertain) };
};

export const reserveBudgetReservation: StoreMember<[key: BudgetLedgerKey, spec: BudgetReservationSpec], boolean> = (brain, key, spec) =>
  storeCall({ member: 'reserveBudgetReservation' }, () => brain.reserveBudgetReservation(key, spec)) as Promise<boolean>;

export const dispatchBudgetReservation: StoreMember<[key: BudgetLedgerKey, id: string, nowIso: string], boolean> = (brain, key, id, nowIso) =>
  storeCall({ member: 'dispatchBudgetReservation' }, () => brain.dispatchBudgetReservation(key, id, nowIso)) as Promise<boolean>;

export const settleBudgetReservation: StoreMember<[key: BudgetLedgerKey, id: string, actual: string], BudgetSettleRow | null> = (brain, key, id, actual) =>
  storeCall({ member: 'settleBudgetReservation' }, () => brain.settleBudgetReservation(key, id, actual)) as Promise<BudgetSettleRow | null>;

export const releaseBudgetReservation: StoreMember<[key: BudgetLedgerKey, id: string], boolean> = (brain, key, id) =>
  storeCall({ member: 'releaseBudgetReservation' }, () => brain.releaseBudgetReservation(key, id)) as Promise<boolean>;
