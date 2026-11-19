/**
 * Trust: the fact withdrawal ledger members (BrainEngine hasCoveringFactWithdrawal, insertFactWithdrawal,
 * listFactWithdrawalDates, moveFactWithdrawalSubject, hasFactWithdrawalForSubject, listFactWithdrawalKeys,
 * isFactClaimWithdrawn, isFactClaimPurged, readSourcePurgeFlags), over
 * `rust/crates/gbrain-store/src/trust/withdrawals.rs`. `withdrawnAt` must be the ISO form `Date#toISOString` gives;
 * the store refuses any other spelling with `invalid_argument` (rust/docs/store/trust.md). The store keeps no purge
 * ledger (`fact_purges`, `take_purges`): every writer of one is raw SQL the Rust engine refuses, so the purge reads
 * match nothing.
 */
import type { BrainEngine } from '../../engine.ts';
import { withDates } from '../store-codec.ts';
import { storeCall, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

export const hasCoveringFactWithdrawal: Member<'hasCoveringFactWithdrawal'> = (brain, sourceId, visibility, factHash, claim, subject) =>
  storeCall({ member: 'hasCoveringFactWithdrawal', sourceId }, () => brain.hasCoveringFactWithdrawal(sourceId, visibility, factHash, claim, subject));

export const insertFactWithdrawal: Member<'insertFactWithdrawal'> = (brain, sourceId, visibility, claim, subject, withdrawnAt) =>
  storeCall({ member: 'insertFactWithdrawal', sourceId }, () => brain.insertFactWithdrawal(sourceId, visibility, claim, subject, withdrawnAt ?? null));

export const listFactWithdrawalDates: Member<'listFactWithdrawalDates'> = async (brain, sourceId, claims, subject) => {
  if (!claims.length) return [];
  const rows: { row_num: number; withdrawn_at: string }[] = await storeCall({ member: 'listFactWithdrawalDates', sourceId },
    () => brain.listFactWithdrawalDates(sourceId, claims.map(c => ({ row_num: c.row_num, claim: c.claim, visibility: c.visibility })), subject ?? null));
  return rows.map(row => withDates(row, ['withdrawn_at']) as unknown as { row_num: number; withdrawn_at: Date });
};

export const moveFactWithdrawalSubject: Member<'moveFactWithdrawalSubject'> = (brain, sourceId, oldSlug, newSlug) =>
  storeCall({ member: 'moveFactWithdrawalSubject', sourceId }, () => brain.moveFactWithdrawalSubject(sourceId, oldSlug, newSlug));

export const hasFactWithdrawalForSubject: Member<'hasFactWithdrawalForSubject'> = (brain, sourceId, subject) =>
  storeCall({ member: 'hasFactWithdrawalForSubject', sourceId }, () => brain.hasFactWithdrawalForSubject(sourceId, subject));

export const listFactWithdrawalKeys: Member<'listFactWithdrawalKeys'> = (brain, sourceId, limit) =>
  storeCall({ member: 'listFactWithdrawalKeys', sourceId }, () => brain.listFactWithdrawalKeys(sourceId, limit));

export const isFactClaimWithdrawn: Member<'isFactClaimWithdrawn'> = (brain, sourceId, visibility, claim, entitySlug, memberPage) =>
  storeCall({ member: 'isFactClaimWithdrawn', sourceId },
    () => brain.isFactClaimWithdrawn(sourceId, visibility ?? null, claim, entitySlug ?? null, memberPage ?? null));

export const isFactClaimPurged: Member<'isFactClaimPurged'> = (brain, sourceId, visibility, claim, entitySlug) =>
  storeCall({ member: 'isFactClaimPurged', sourceId }, () => brain.isFactClaimPurged(sourceId, visibility, claim, entitySlug ?? null));

export const readSourcePurgeFlags: Member<'readSourcePurgeFlags'> = (brain, sourceId) =>
  storeCall({ member: 'readSourcePurgeFlags', sourceId }, () => brain.readSourcePurgeFlags(sourceId));
