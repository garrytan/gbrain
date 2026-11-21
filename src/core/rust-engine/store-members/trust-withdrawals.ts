/**
 * Trust: the fact withdrawal ledger members (BrainEngine hasCoveringFactWithdrawal, isFactWithdrawn, isFactPurged, insertFactWithdrawal,
 * listFactWithdrawalDates, moveFactWithdrawalSubject, hasFactWithdrawalForSubject, listFactWithdrawalKeys,
 * readFactCacheWatermark, readTrustGeneration), over `rust/crates/gbrain-store/src/trust/withdrawals.rs`. The
 * watermark's access digest is that of empty folder access tables: the store keeps none. The trust generation is the
 * store's commit sequence, which moves on every commit. `withdrawnAt` must be the ISO form `Date#toISOString` gives;
 * the store refuses any other spelling with `invalid_argument` (rust/docs/store/trust.md). The purge reads answer from
 * the store's fact purge ledger (`facts/purge_ledger.rs`); it keeps no take purge ledger, so `takes` is false.
 */
import type { BrainEngine } from '../../engine.ts';
import { withDates } from '../store-codec.ts';
import { storeCall, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

export const hasCoveringFactWithdrawal: Member<'hasCoveringFactWithdrawal'> = (brain, sourceId, visibility, factHash, claim, subject) =>
  storeCall({ member: 'hasCoveringFactWithdrawal', sourceId }, () => brain.hasCoveringFactWithdrawal(sourceId, visibility, factHash, claim, subject));

export const isFactWithdrawn: Member<'isFactWithdrawn'> = (brain, sourceId, visibility, claim, entitySlug, memberPage) =>
  storeCall({ member: 'isFactWithdrawn', sourceId }, () => brain.isFactWithdrawn(sourceId, visibility ?? null, claim, entitySlug ?? null, memberPage ?? null));

export const isFactPurged: Member<'isFactPurged'> = (brain, sourceId, visibility, claim, entitySlug) =>
  storeCall({ member: 'isFactPurged', sourceId }, () => brain.isFactPurged(sourceId, visibility, claim, entitySlug ?? null));

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

export const readFactCacheWatermark: Member<'readFactCacheWatermark'> = (brain, sourceId) =>
  storeCall({ member: 'readFactCacheWatermark', sourceId }, () => brain.readFactCacheWatermark(sourceId));

export const readTrustGeneration: Member<'readTrustGeneration'> = (brain) =>
  storeCall({ member: 'readTrustGeneration' }, () => brain.readTrustGeneration());

export const readSourcePurgeFlags: Member<'readSourcePurgeFlags'> = (brain, sourceId) =>
  storeCall({ member: 'readSourcePurgeFlags', sourceId }, () => brain.readSourcePurgeFlags(sourceId));
