/**
 * Group 5 facts members that serve the owner from the stamped trust columns and the write-gate receipts, served from the
 * facts store (rust/crates/gbrain-store/src/facts/trust_owner.rs): `readFactForOwnerAction`, `countDerivedFactTaint`
 * and `listStandingPreferences` (src/core/engine-sql/facts-trust.ts).
 *
 * `readFactForOwnerAction` refuses an id that is not an integer rather than guess at PGLite's bigint error, and turns
 * `expired_at` into a `Date` as the SQL engines return it (the owner binding hashes `String(expired_at)`).
 * `listStandingPreferences` passes the claim rule's owner floor and connector kinds (trust/claim-state.ts) so the store
 * keeps no second copy of them, and turns `created_at` into a `Date`.
 */
import type { BrainEngine } from '../../engine.ts';
import { CONNECTOR_SOURCE_KINDS } from '../../persistence/connector-kinds.ts';
import { OWNER_TIER_FLOOR } from '../../trust/tier.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';
import { withDates } from '../store-codec.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;
type Row = Record<string, unknown>;

export const readFactForOwnerAction: Member<'readFactForOwnerAction'> = async (brain, id) => {
  if (!Number.isSafeInteger(id)) refuseMember('readFactForOwnerAction', 'an id that is not an integer');
  const row: Row | null = await storeCall({ member: 'readFactForOwnerAction' }, () => brain.readFactForOwnerAction({ id }));
  return row ? withDates(row, ['expired_at']) : null;
};

export const countDerivedFactTaint: Member<'countDerivedFactTaint'> = (brain) =>
  storeCall({ member: 'countDerivedFactTaint' }, () => brain.countDerivedFactTaint());

export const listStandingPreferences: Member<'listStandingPreferences'> = async (brain, opts) => {
  const rows: Row[] = await storeCall({ member: 'listStandingPreferences', sourceId: opts.sourceId }, () => brain.listStandingPreferences({
    sourceId: opts.sourceId ?? null, since: opts.since?.toISOString() ?? null,
    ownerFloor: OWNER_TIER_FLOOR, connectorKinds: [...CONNECTOR_SOURCE_KINDS],
  }));
  return rows.map(r => withDates(r, ['created_at'])) as never;
};
