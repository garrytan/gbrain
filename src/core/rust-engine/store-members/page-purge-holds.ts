/**
 * The parks and owed-purge records of a derived-origin purge (BrainEngine listPurgeOrigins, upsertDerivedOriginPark,
 * recordOwedPurgeRows and deleteOriginHoldRows; SQL in engine-sql/origin-holds.ts), served from the store's page records
 * and its op checkpoint rows (gbrain-store `persistence/origin_holds.rs`; rust/docs/store/label_door.md, "The purge's origin
 * parks and owed-purge records").
 *
 * `listPurgeOrigins` passes the process's alias-honoring setting, as the label door members do. The writes run on the store
 * handle the caller holds, so inside a purge transaction they are part of it. Every statement reads or writes what the store
 * keeps, so none answers without a store call.
 */
import type { BrainEngine } from '../../engine.ts';
import { privacyAliasSql, privateSnapshotFilterFragment } from '../../search/private-visibility.ts';
import { storeCall, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

const honorAliases = (): boolean => privateSnapshotFilterFragment('h').includes(privacyAliasSql('h'));

export const listPurgeOrigins: Member<'listPurgeOrigins'> = (brain, ids, recheckParked) =>
  storeCall({ member: 'listPurgeOrigins' }, () => brain.listPurgeOrigins([...ids], recheckParked, honorAliases()));

export const upsertDerivedOriginPark: Member<'upsertDerivedOriginPark'> = async (brain, pageId, park) => {
  // The SQL binds `JSON.stringify([park])`: the store keeps what that text parses back to.
  const [stored] = JSON.parse(JSON.stringify([park])) as unknown[];
  await storeCall({ member: 'upsertDerivedOriginPark' }, () => brain.upsertDerivedOriginPark(pageId, stored));
};

export const recordOwedPurgeRows: Member<'recordOwedPurgeRows'> = (brain, pageId, requestId) =>
  storeCall({ member: 'recordOwedPurgeRows' }, () => brain.recordOwedPurgeRows(pageId, requestId));

export const deleteOriginHoldRows: Member<'deleteOriginHoldRows'> = async (brain, op, pageIds) =>
  Number(await storeCall({ member: 'deleteOriginHoldRows' }, () => brain.deleteOriginHoldRows(op, [...pageIds])));
