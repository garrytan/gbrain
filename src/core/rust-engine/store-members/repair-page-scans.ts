/**
 * The page scans of the safe-chunks and origin-twins repair plans (BrainEngine listSafeChunksPending through
 * listRepairScanPages, the statements of engine-sql/repair-page-scans.ts). The store scans its page records as the
 * SQL filters its rows (rust/crates/gbrain-store/src/repair_scans.rs).
 */
import type { LegacyOriginPair, LiveOriginPage, OriginTwinGroupRow, RepairScanPage, RepairScanQuery, SafeChunksPendingRow } from '../../engine-sql/repair-page-scans.ts';
import { CREDENTIAL_RESEAL_PRODUCER } from '../../page-state/credential-reseal-hold.ts';
import { storeCall, type StoreMember } from './common.ts';

const cap = (limit: number) => Math.max(1, Math.floor(limit));

export const listSafeChunksPending: StoreMember<[sourceIds: readonly string[]], SafeChunksPendingRow[]> = async (brain, sourceIds) =>
  await storeCall({ member: 'listSafeChunksPending' }, () => brain.listSafeChunksPending([...sourceIds], CREDENTIAL_RESEAL_PRODUCER)) as SafeChunksPendingRow[];

export const listOriginTwinGroups: StoreMember<[sourceId: string, limit: number], OriginTwinGroupRow[]> = async (brain, sourceId, limit) =>
  await storeCall({ member: 'listOriginTwinGroups', sourceId }, () => brain.listOriginTwinGroups(sourceId, cap(limit))) as OriginTwinGroupRow[];

export const listLegacyOriginPairs: StoreMember<[sourceId: string, prefix: string, limit: number], LegacyOriginPair[]> = async (brain, sourceId, prefix, limit) =>
  await storeCall({ member: 'listLegacyOriginPairs', sourceId }, () => brain.listLegacyOriginPairs(sourceId, prefix, cap(limit))) as LegacyOriginPair[];

export const listLiveOriginPages: StoreMember<[sourceId: string, paths: readonly string[]], LiveOriginPage[]> = async (brain, sourceId, paths) =>
  await storeCall({ member: 'listLiveOriginPages', sourceId }, () => brain.listLiveOriginPages(sourceId, [...paths])) as LiveOriginPage[];

export const countLiveFileBackedPages: StoreMember<[sourceId: string, opts?: { nonBlank?: boolean }], number> = async (brain, sourceId, opts = {}) =>
  Number(await storeCall({ member: 'countLiveFileBackedPages', sourceId }, () => brain.countLiveFileBackedPages(sourceId, opts.nonBlank === true)));

/** The store takes the query as one shape: `ids`, else `slugs`, else the page past `afterId` (`limit`, `legacy`). */
export const listRepairScanPages: StoreMember<[sourceId: string, q: RepairScanQuery], RepairScanPage[]> = async (brain, sourceId, q) =>
  await storeCall({ member: 'listRepairScanPages', sourceId }, () => brain.listRepairScanPages(sourceId, {
    ids: 'ids' in q ? q.ids.map(Number) : null, slugs: 'slugs' in q ? [...q.slugs] : null,
    after_id: 'afterId' in q ? Math.max(0, Math.floor(q.afterId)) : 0, limit: 'afterId' in q ? cap(q.limit) : 0, legacy: 'afterId' in q && q.legacy === true,
  })) as RepairScanPage[];
