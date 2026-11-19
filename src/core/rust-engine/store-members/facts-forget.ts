/**
 * The facts members a forget and a proposal review use, served from the facts store
 * (rust/crates/gbrain-store/src/facts/forget.rs): `readFactForForget`, `expireFactSuperseded`, `expireFactAtDate`
 * and `readWithdrawalAnchor` (src/core/engine-sql/facts-trust.ts).
 *
 * An id that is not a whole number refuses rather than guess at PGLite's `bigint` error, and so does a `validUntil`
 * that is not an ISO instant or a date, or a `today` that is not a real `YYYY-MM-DD` date: the callers pass
 * `toISOString()` (or null) and a formatted date, so the refusal is a guard, never a path they take.
 */
import type { BrainEngine } from '../../engine.ts';
import type { ForgetFactRow } from '../../engine-sql/facts-trust.ts';
import { withDates } from '../store-codec.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function wholeId(member: string, id: number): void {
  if (!Number.isSafeInteger(id)) refuseMember(member, 'an id that is not a whole number');
}

export const readFactForForget: Member<'readFactForForget'> = async (brain, id) => {
  wholeId('readFactForForget', id);
  const row: ForgetFactRow | null = await storeCall({ member: 'readFactForForget' }, () => brain.readFactForForget({ id }));
  return row ? withDates(row, ['expired_at']) : null;
};

/** A real `YYYY-MM-DD` day. */
const realDay = (day: string): boolean => DATE.test(day) && new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day;

export const expireFactSuperseded: Member<'expireFactSuperseded'> = async (brain, factId, validUntil) => {
  wholeId('expireFactSuperseded', factId);
  // `$2::timestamptz` reads a bare date as that day's midnight (UTC, the session zone every engine runs in).
  let until = validUntil;
  if (until !== null && realDay(until)) until = `${until}T00:00:00Z`;
  else if (until !== null && (!ISO_INSTANT.test(until) || Number.isNaN(Date.parse(until)))) {
    refuseMember('expireFactSuperseded', 'a validUntil that is not an ISO instant or a date');
  }
  await storeCall({ member: 'expireFactSuperseded' }, () => brain.expireFactSuperseded({ factId, validUntil: until }));
};

export const expireFactAtDate: Member<'expireFactAtDate'> = async (brain, factId, today) => {
  wholeId('expireFactAtDate', factId);
  if (!realDay(today)) {
    refuseMember('expireFactAtDate', 'a date that is not a real YYYY-MM-DD day');
  }
  await storeCall({ member: 'expireFactAtDate' }, () => brain.expireFactAtDate({ factId, today }));
};

export const readWithdrawalAnchor: Member<'readWithdrawalAnchor'> = async (brain, factId, sourceId) => {
  wholeId('readWithdrawalAnchor', factId);
  return storeCall({ member: 'readWithdrawalAnchor', sourceId }, () => brain.readWithdrawalAnchor({ factId, sourceId }));
};
