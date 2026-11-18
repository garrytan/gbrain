/**
 * The decide store (engine-sql/decide-store.ts), served by the store (rust/docs/store/decide-store.md): decide state,
 * the spend ledger, receipts and calibrations. Timestamps cross the binding as ISO text and come back as `Date`s, as
 * PGLite returns them.
 */
import {
  receiptRowValues, type DecideCalibration, type DecideCalibrationInsert, type DecideQualification, spendRowValues, type DecideReceiptInsert, type DecideReceiptStat, type DecideReplayReceipt,
  type DecideResolvedModel, type DecideSlotUsageRow, type DecideSpendInsert, type DecideSpendSlotTotals,
} from '../../engine-sql/decide-store.ts';
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

// ---------------------------------------------------------------- receipts

/** Like the spend rows, the receipt rows go over as the shared row values (engine-sql). */
export const insertDecideReceipts: StoreMember<[rows: readonly DecideReceiptInsert[]], void> = async (brain, rows) => {
  if (rows.length === 0) return;
  await storeCall({ member: 'insertDecideReceipts' }, () => brain.insertDecideReceipts(receiptRowValues(rows)));
};

export const pruneDecideReceipts: StoreMember<[retentionDays: number], number> = (brain, retentionDays) =>
  storeCall({ member: 'pruneDecideReceipts' }, () => brain.pruneDecideReceipts(retentionDays));

export const listDecideReceiptStats: StoreMember<[opts: { slot?: string; sinceHours: number }], DecideReceiptStat[]> = (brain, opts) =>
  storeCall({ member: 'listDecideReceiptStats' }, () => brain.listDecideReceiptStats(opts.slot ?? null, opts.sinceHours));

export const decideSlotUsage: StoreMember<[sinceHours: number], DecideSlotUsageRow[]> = (brain, sinceHours) =>
  storeCall({ member: 'decideSlotUsage' }, () => brain.decideSlotUsage(sinceHours));

export const decideConflictNoEntityCounts: StoreMember<[sinceHours: number], { receipts: number; skipped: number }> = (brain, sinceHours) =>
  storeCall({ member: 'decideConflictNoEntityCounts' }, () => brain.decideConflictNoEntityCounts(sinceHours));

export const listDecideReplayReceipts: StoreMember<[slot: string, sinceHours: number], DecideReplayReceipt[]> = (brain, slot, sinceHours) =>
  storeCall({ member: 'listDecideReplayReceipts' }, () => brain.listDecideReplayReceipts(slot, sinceHours));

export const listDecideResolvedModels: StoreMember<[sinceHours: number], DecideResolvedModel[]> = async (brain, sinceHours) => {
  const rows = (await storeCall({ member: 'listDecideResolvedModels' }, () => brain.listDecideResolvedModels(sinceHours))) as Array<Omit<DecideResolvedModel, 'last_at'> & { last_at: string }>;
  return rows.map((r) => ({ ...r, last_at: new Date(r.last_at) }));
};

export const listDecideMixedModelDecisions: StoreMember<[sinceHours: number], Array<{ slot: string; n: number }>> = (brain, sinceHours) =>
  storeCall({ member: 'listDecideMixedModelDecisions' }, () => brain.listDecideMixedModelDecisions(sinceHours));

// ---------------------------------------------------------------- calibrations

/** The row crosses as given (a column left out is a null the store refuses, as the SQL does); the id comes back a number. */
export const insertDecideCalibration: StoreMember<[row: DecideCalibrationInsert], number> = async (brain, row) =>
  Number(await storeCall({ member: 'insertDecideCalibration' }, () => brain.insertDecideCalibration(row)));

export const storeDecideQualification: StoreMember<[id: number, q: DecideQualification], void> = async (brain, id, q) => {
  await storeCall({ member: 'storeDecideQualification' }, () => brain.storeDecideQualification(id, q));
};

type CalibrationOnTheWire = Omit<DecideCalibration, 'created_at' | 'qualified_at' | 'retired_at'> & {
  created_at: string; qualified_at: string | null; retired_at: string | null;
};

const calibrationFromWire = (r: CalibrationOnTheWire): DecideCalibration => ({
  ...r,
  created_at: new Date(r.created_at),
  qualified_at: r.qualified_at === null ? null : new Date(r.qualified_at),
  retired_at: r.retired_at === null ? null : new Date(r.retired_at),
});

export const listDecideCalibrations: StoreMember<[opts?: { slot?: string; includeRetired?: boolean }], DecideCalibration[]> = async (brain, opts) => {
  const rows = (await storeCall({ member: 'listDecideCalibrations' }, () =>
    brain.listDecideCalibrations(opts?.slot ?? null, opts?.includeRetired ?? false))) as CalibrationOnTheWire[];
  return rows.map(calibrationFromWire);
};

export const getDecideCalibration: StoreMember<[id: number], DecideCalibration | null> = async (brain, id) => {
  const row = (await storeCall({ member: 'getDecideCalibration' }, () => brain.getDecideCalibration(id))) as CalibrationOnTheWire | null;
  return row === null ? null : calibrationFromWire(row);
};

export const setDecideCalibrationRetired: StoreMember<[id: number, retired: boolean], boolean> = (brain, id, retired) =>
  storeCall({ member: 'setDecideCalibrationRetired' }, () => brain.setDecideCalibrationRetired(id, retired));
