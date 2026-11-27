/**
 * The retention purge's bookkeeping (BrainEngine releaseStaleOriginParkHolds, listOwedPurgeRecords, pruneOwedPurgeRecords,
 * pruneOriginParkRecords, prunePurgeParkRecords, recordPurgeFailureRecord, deletePurgeParkRecord, markPurgeParksInactive,
 * dropRearmedPurgeParks, listReleasedPurgeOrigins, listManagedPurgeCandidates and listExpiringOriginPages; SQL in
 * engine-sql/retention-purge.ts), served from the store's page records and its op checkpoint rows (gbrain-store
 * `persistence/retention_purge.rs`; rust/docs/store/label_door.md, "The retention purge's bookkeeping").
 *
 * `listExpiringOriginPages` passes the process's alias-honoring setting, as the label door members do. The writes run on
 * the store handle the caller holds, so inside a purge transaction they are part of it. Every statement reads or writes
 * what the store keeps, so none answers without a store call.
 */
import type { BrainEngine } from '../../engine.ts';
import type { ReleasedPurgeOrigin } from '../../engine-sql/retention-purge.ts';
import { privacyAliasSql, privateSnapshotFilterFragment } from '../../search/private-visibility.ts';
import { storeCall, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

const honorAliases = (): boolean => privateSnapshotFilterFragment('h').includes(privacyAliasSql('h'));

export const releaseStaleOriginParkHolds: Member<'releaseStaleOriginParkHolds'> = async (brain, op) => {
  await storeCall({ member: 'releaseStaleOriginParkHolds' }, () => brain.releaseStaleOriginParkHolds(op));
};

export const listOwedPurgeRecords: Member<'listOwedPurgeRecords'> = (brain, op) =>
  storeCall({ member: 'listOwedPurgeRecords' }, () => brain.listOwedPurgeRecords(op));

export const pruneOwedPurgeRecords: Member<'pruneOwedPurgeRecords'> = async (brain, op) => {
  await storeCall({ member: 'pruneOwedPurgeRecords' }, () => brain.pruneOwedPurgeRecords(op));
};

export const pruneOriginParkRecords: Member<'pruneOriginParkRecords'> = async (brain, op) => {
  await storeCall({ member: 'pruneOriginParkRecords' }, () => brain.pruneOriginParkRecords(op));
};

export const prunePurgeParkRecords: Member<'prunePurgeParkRecords'> = async (brain, op) => {
  await storeCall({ member: 'prunePurgeParkRecords' }, () => brain.prunePurgeParkRecords(op));
};

export const recordPurgeFailureRecord: Member<'recordPurgeFailureRecord'> = async (brain, row) => {
  await storeCall({ member: 'recordPurgeFailureRecord' }, () =>
    brain.recordPurgeFailureRecord(row.op, row.key, row.first, row.code, row.reason, row.failedAt, row.version));
};

export const deletePurgeParkRecord: Member<'deletePurgeParkRecord'> = async (brain, op, key) => {
  await storeCall({ member: 'deletePurgeParkRecord' }, () => brain.deletePurgeParkRecord(op, key));
};

export const markPurgeParksInactive: Member<'markPurgeParksInactive'> = async (brain, op, sourceId) => {
  await storeCall({ member: 'markPurgeParksInactive' }, () => brain.markPurgeParksInactive(op, sourceId));
};

export const dropRearmedPurgeParks: Member<'dropRearmedPurgeParks'> = async (brain, op, sourceId) =>
  Number(await storeCall({ member: 'dropRearmedPurgeParks' }, () => brain.dropRearmedPurgeParks(op, sourceId)));

export const listReleasedPurgeOrigins: Member<'listReleasedPurgeOrigins'> = async (brain, release, excludeIds, hours) => {
  const rows = await storeCall({ member: 'listReleasedPurgeOrigins' }, () => brain.listReleasedPurgeOrigins([...release], [...excludeIds], hours)) as Array<{ slug: string; source_id: string; deleted_at: string }>;
  // The SQL engines hand `deleted_at` back as a Date (timestamptz).
  return rows.map((row): ReleasedPurgeOrigin => ({ slug: row.slug, source_id: row.source_id, deleted_at: new Date(row.deleted_at) }));
};

export const listManagedPurgeCandidates: Member<'listManagedPurgeCandidates'> = (brain, hours, release, hold) =>
  storeCall({ member: 'listManagedPurgeCandidates' }, () => brain.listManagedPurgeCandidates(hours, [...release], [...hold]));

export const listExpiringOriginPages: Member<'listExpiringOriginPages'> = (brain, hours) =>
  storeCall({ member: 'listExpiringOriginPages' }, () => brain.listExpiringOriginPages(hours, honorAliases()));
