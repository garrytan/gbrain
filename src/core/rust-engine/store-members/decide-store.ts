/**
 * The decide store (engine-sql/decide-store.ts), served by the store (rust/docs/store/decide-store.md): decide state,
 * the spend ledger, receipts and calibrations. Timestamps cross the binding as ISO text and come back as `Date`s, as
 * PGLite returns them.
 */
import { spendRowValues, type DecideSpendInsert, type DecideSpendSlotTotals } from '../../engine-sql/decide-store.ts';
import { storeCall, type StoreMember } from './common.ts';

// ---------------------------------------------------------------- state

export const readDecideState: StoreMember<[key: string], string | null> = (brain, key) =>
  storeCall({ member: 'readDecideState' }, () => brain.readDecideState(key));

export const upsertDecideState: StoreMember<[key: string, value: string], void> = async (brain, key, value) => {
  await storeCall({ member: 'upsertDecideState' }, () => brain.upsertDecideState(key, value ?? null));
};

export const deleteDecideState: StoreMember<[key: string], void> = async (brain, key) => {
  await storeCall({ member: 'deleteDecideState' }, () => brain.deleteDecideState(key));
};

export const ensureDecideState: StoreMember<[key: string, value: string], string | null> = (brain, key, value) =>
  storeCall({ member: 'ensureDecideState' }, () => brain.ensureDecideState(key, value ?? null));

// ---------------------------------------------------------------- spend

/** The rows go over as the shared row values (engine-sql), so a column left out is a null the store refuses, as the SQL does. */
export const insertDecideSpend: StoreMember<[rows: readonly DecideSpendInsert[]], void> = async (brain, rows) => {
  if (rows.length === 0) return;
  await storeCall({ member: 'insertDecideSpend' }, () => brain.insertDecideSpend(spendRowValues(rows)));
};

export const dailyDecideSpend: StoreMember<[since: Date], { total: number; remote: number }> = (brain, since) =>
  storeCall({ member: 'dailyDecideSpend' }, () => brain.dailyDecideSpend(since.toISOString()));

export const listDecideSpendBySlot: StoreMember<[], DecideSpendSlotTotals[]> = (brain) =>
  storeCall({ member: 'listDecideSpendBySlot' }, () => brain.listDecideSpendBySlot());
