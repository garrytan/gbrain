/**
 * The daily budget ledger's writes (BrainEngine reclaimBudgetReservations, reserveBudgetReservation,
 * dispatchBudgetReservation, settleBudgetReservation, releaseBudgetReservation; engine-sql/budget-ledger-writes.ts). The
 * store keeps no budget ledger yet, so each refuses by name and writes nothing; the paid-call protocol
 * (budget/daily-ledger.ts) reads a refusal as `ledger_unavailable` and makes no paid call. rust/docs/store/repair-fences.md.
 */
import { refuseMember, type StoreMember } from './common.ts';

const NO_LEDGER = 'the store keeps no budget ledger yet; nothing was written';

export const reclaimBudgetReservations: StoreMember<[key: unknown, nowIso: string], { released: number; uncertain: number }> = async () =>
  refuseMember('reclaimBudgetReservations', NO_LEDGER);
export const reserveBudgetReservation: StoreMember<[key: unknown, spec: unknown], boolean> = async () => refuseMember('reserveBudgetReservation', NO_LEDGER);
export const dispatchBudgetReservation: StoreMember<[key: unknown, id: string, nowIso: string], boolean> = async () =>
  refuseMember('dispatchBudgetReservation', NO_LEDGER);
export const settleBudgetReservation: StoreMember<[key: unknown, id: string, actual: string], null> = async () => refuseMember('settleBudgetReservation', NO_LEDGER);
export const releaseBudgetReservation: StoreMember<[key: unknown, id: string], boolean> = async () => refuseMember('releaseBudgetReservation', NO_LEDGER);
