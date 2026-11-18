/**
 * The spend reservations and the lease-pressure log (engine-sql/jobs-spend.ts), served by the store
 * (rust/docs/store/jobs-spend.md). A reservation's expiry crosses the binding as ISO text, and a bounce's time comes
 * back as a `Date`, as PGLite returns it.
 */
import type {
  ExpireSpendScope, JobSpendTreeSpec, LeasePressureFilter, LeasePressureInsert, LeasePressureRow, SettleSpendOutcome,
  SpendReservationInsert, SpendTreeRow,
} from '../../engine-sql/jobs-spend.ts';
import { withDates } from '../store-codec.ts';
import { storeCall, type StoreMember } from './common.ts';

export const readJobSpendTree: StoreMember<[spec: JobSpendTreeSpec], SpendTreeRow[]> = (brain, spec) =>
  storeCall({ member: 'readJobSpendTree' }, () => brain.readJobSpendTree(spec));

export const insertSpendReservation: StoreMember<[row: SpendReservationInsert], void> = async (brain, row) => {
  await storeCall({ member: 'insertSpendReservation' }, () => brain.insertSpendReservation({ ...row, expires_at: row.expires_at.toISOString() }));
};

export const expireSpendReservations: StoreMember<[scope?: ExpireSpendScope], number> = (brain, scope) =>
  storeCall({ member: 'expireSpendReservations' }, () => brain.expireSpendReservations(scope ?? {}));

export const settleSpendReservation: StoreMember<[reservationId: string, actualCents: number], SettleSpendOutcome> = (brain, reservationId, actualCents) =>
  storeCall({ member: 'settleSpendReservation' }, () => brain.settleSpendReservation(reservationId, actualCents));

export const markSpendUsageUnknown: StoreMember<[reservationId: string, reason: string], boolean> = (brain, reservationId, reason) =>
  storeCall({ member: 'markSpendUsageUnknown' }, () => brain.markSpendUsageUnknown(reservationId, reason));

export const insertLeasePressure: StoreMember<[row: LeasePressureInsert], void> = async (brain, row) => {
  await storeCall({ member: 'insertLeasePressure' }, () => brain.insertLeasePressure(row));
};

export const countLeasePressure: StoreMember<[filter?: LeasePressureFilter], number> = (brain, filter) =>
  storeCall({ member: 'countLeasePressure' }, () => brain.countLeasePressure(filter ?? {}));

export const listRecentLeasePressure: StoreMember<[windowMs: number, limit: number], LeasePressureRow[]> = async (brain, windowMs, limit) => {
  const rows: LeasePressureRow[] =
    await storeCall({ member: 'listRecentLeasePressure' }, () => brain.listRecentLeasePressure(windowMs, limit));
  return rows.map(r => withDates(r, ['bounced_at'] as const));
};
