/**
 * The page scans of the safe-chunks and origin-twins repair plans (BrainEngine listSafeChunksPending through
 * listTwinMergeLosers, the statements of engine-sql/repair-page-scans.ts). The store scans its page records as the
 * SQL filters its rows (rust/crates/gbrain-store/src/repair_scans.rs).
 */
import type { FileTombstone, FileTombstoneQuery, LegacyOriginPair, LiveOriginPage, OriginClaimantRow, OriginTwinGroupRow, RepairScanPage, RepairScanQuery, SafeChunksPendingRow, TwinMergeLosers, UnreviewedSyncTombstone } from '../../engine-sql/repair-page-scans.ts';
import { CREDENTIAL_RESEAL_PRODUCER } from '../../page-state/credential-reseal-hold.ts';
import { privatePagesFilterFragment } from '../../search/private-visibility.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';
import { pagePolicyFlags } from './private-provenance.ts';

const cap = (limit: number) => Math.max(1, Math.floor(limit));

export const listSafeChunksPending: StoreMember<[sourceIds: readonly string[]], SafeChunksPendingRow[]> = async (brain, sourceIds) =>
  await storeCall({ member: 'listSafeChunksPending' }, () => brain.listSafeChunksPending([...sourceIds], CREDENTIAL_RESEAL_PRODUCER)) as SafeChunksPendingRow[];

export const listOriginTwinGroups: StoreMember<[sourceId: string, limit: number], OriginTwinGroupRow[]> = async (brain, sourceId, limit) =>
  await storeCall({ member: 'listOriginTwinGroups', sourceId }, () => brain.listOriginTwinGroups(sourceId, cap(limit))) as OriginTwinGroupRow[];

export const listLegacyOriginPairs: StoreMember<[sourceId: string, prefix: string, limit: number], LegacyOriginPair[]> = async (brain, sourceId, prefix, limit) =>
  await storeCall({ member: 'listLegacyOriginPairs', sourceId }, () => brain.listLegacyOriginPairs(sourceId, prefix, cap(limit))) as LegacyOriginPair[];

export const listLiveOriginPages: StoreMember<[sourceId: string, paths: readonly string[]], LiveOriginPage[]> = async (brain, sourceId, paths) =>
  await storeCall({ member: 'listLiveOriginPages', sourceId }, () => brain.listLiveOriginPages(sourceId, [...paths])) as LiveOriginPage[];

/** The store judges the no-caller page policy the SQL statement renders (the same flags the relationship evidence read sends). */
export const listOriginClaimants: StoreMember<[sourceId: string, ids: readonly number[]], OriginClaimantRow[]> = async (brain, sourceId, ids) => {
  if (!ids.every(id => Number.isSafeInteger(id) && id > 0)) refuseMember('listOriginClaimants', 'a page id that is not a positive integer');
  const rows = await storeCall({ member: 'listOriginClaimants', sourceId }, () =>
    brain.listOriginClaimants({ sourceId, ids: ids.map(Number), policy: pagePolicyFlags(privatePagesFilterFragment('p')) })) as OriginClaimantRow[];
  return rows.map(row => ({ ...row, id: Number(row.id) }));
};

export const countLiveFileBackedPages: StoreMember<[sourceId: string, opts?: { nonBlank?: boolean }], number> = async (brain, sourceId, opts = {}) =>
  Number(await storeCall({ member: 'countLiveFileBackedPages', sourceId }, () => brain.countLiveFileBackedPages(sourceId, opts.nonBlank === true)));

/** The store takes the query as one shape: `ids`, else `slugs`, else the page past `afterId` (`limit`, `legacy`). */
export const listRepairScanPages: StoreMember<[sourceId: string, q: RepairScanQuery], RepairScanPage[]> = async (brain, sourceId, q) =>
  await storeCall({ member: 'listRepairScanPages', sourceId }, () => brain.listRepairScanPages(sourceId, {
    ids: 'ids' in q ? q.ids.map(Number) : null, slugs: 'slugs' in q ? [...q.slugs] : null,
    after_id: 'afterId' in q ? Math.max(0, Math.floor(q.afterId)) : 0, limit: 'afterId' in q ? cap(q.limit) : 0, legacy: 'afterId' in q && q.legacy === true,
  })) as RepairScanPage[];

/** The store reads `deleted_at` as microseconds; the SQL engines' Date keeps milliseconds, so it is cut the same way. */
export const listFileTombstones: StoreMember<[sourceId: string, q: FileTombstoneQuery], FileTombstone[]> = async (brain, sourceId, q) =>
  (await storeCall({ member: 'listFileTombstones', sourceId }, () => brain.listFileTombstones(sourceId, {
    before: q.before === null ? null : Math.floor(q.before), limit: cap(q.limit),
  })) as FileTombstone[]).map(row => ({ ...row, deleted_at: new Date(row.deleted_at).toISOString() }));

/** The tombstones a managed sync made that no live page backs by content (gbrain-store `repair_scans`). */
export const listUnreviewedSyncTombstones: StoreMember<[olderThanHours: number], UnreviewedSyncTombstone[]> = async (brain, olderThanHours) =>
  (await storeCall({ member: 'listUnreviewedSyncTombstones' }, () => brain.listUnreviewedSyncTombstones(Math.max(0, Math.floor(olderThanHours))))) as UnreviewedSyncTombstone[];

/** The twin-merge conflict read: the store reads the pair's links, link transitions, timeline and raw data. */
export const listTwinMergeLosers: StoreMember<[survivorId: number, twinId: number], TwinMergeLosers> = async (brain, survivorId, twinId) => {
  if (![survivorId, twinId].every(id => Number.isSafeInteger(id) && id > 0)) refuseMember('listTwinMergeLosers', 'a page id that is not a positive integer');
  return await storeCall({ member: 'listTwinMergeLosers' }, () => brain.listTwinMergeLosers(survivorId, twinId)) as TwinMergeLosers;
};
