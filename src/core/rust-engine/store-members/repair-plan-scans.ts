/**
 * The plan reads of the frontmatter, segmented-tiling, attribution-backfill and failed-writes repairs, the drift-conflict audit and the source
 * hold listing (BrainEngine listPagesByOriginPath through readDriftConflictDetails, the statements of engine-sql/repair-plan-scans.ts). The store
 * scans its page, body, checkpoint and request records as the SQL filters its rows (rust/crates/gbrain-store/src/repair_plan_scans.rs,
 * drift_conflicts.rs). `listDriftConflictGroups`' `excludePrivate` is the caller's remote read floor as a store page policy
 * (private-provenance.ts `storePageTextPolicy`, the caller's reader identity included); any other caller policy refuses.
 */
import {
  untiledPageOf, type AttributionTable, type DriftConflictBounds, type DriftConflictDetails, type DriftConflictGroups, type DriftConflictQuery, type FailedWriteQuery, type FailedWriteRow, type OriginPathPageRow, type SourceHoldQuery, type SourceHoldRecordRow, type UntiledPage, type UntiledPageQuery, type UntiledPageRow,
} from '../../engine-sql/repair-plan-scans.ts';
import { storeCall, type StoreMember } from './common.ts';
import { storePageTextPolicy } from './private-provenance.ts';
import { remoteReadFloorSql } from '../../search/private-visibility.ts';

export const listPagesByOriginPath: StoreMember<[sourceId: string], OriginPathPageRow[]> = async (brain, sourceId) =>
  await storeCall({ member: 'listPagesByOriginPath', sourceId }, () => brain.listPagesByOriginPath(sourceId)) as OriginPathPageRow[];

export const countSegmentedOriginPages: StoreMember<[sourceIds: readonly string[]], number> = async (brain, sourceIds) =>
  Number(await storeCall({ member: 'countSegmentedOriginPages' }, () => brain.countSegmentedOriginPages([...sourceIds])));

export const listSegmentedPageSlugs: StoreMember<[sourceId: string], string[]> = (brain, sourceId) =>
  storeCall({ member: 'listSegmentedPageSlugs' }, () => brain.listSegmentedPageSlugs(sourceId));

export const listUntiledSegmentedPages: StoreMember<[opts?: UntiledPageQuery], UntiledPage[]> = async (brain, opts = {}) => {
  // Postgres refuses `LIMIT -1` ("LIMIT must not be negative"), so a negative limit is refused here too, before any read.
  if (opts.limit !== undefined && opts.limit < 0) {
    throw Object.assign(new Error('listUntiledSegmentedPages limit: LIMIT must not be negative'), { code: 'invalid_argument' });
  }
  const limit = Math.floor(opts.limit ?? 1000);
  const rows = await storeCall({ member: 'listUntiledSegmentedPages' }, () =>
    brain.listUntiledSegmentedPages(opts.sourceIds ? [...opts.sourceIds] : null, opts.slugs ? [...opts.slugs] : null, limit)) as UntiledPageRow[];
  return rows.map(untiledPageOf);
};

export const listSourceHoldRecords: StoreMember<[op: string, opts?: SourceHoldQuery], SourceHoldRecordRow[]> = async (brain, op, opts = {}) =>
  await storeCall({ member: 'listSourceHoldRecords' }, () =>
    brain.listSourceHoldRecords(op, opts.sourceIds ? [...opts.sourceIds] : null, opts.runId ?? null)) as SourceHoldRecordRow[];

export const listProvenAttributionTargets: StoreMember<[table: AttributionTable, sourceIds: readonly string[]], number[]> = async (brain, table, sourceIds) =>
  (await storeCall({ member: 'listProvenAttributionTargets' }, () => brain.listProvenAttributionTargets(table, [...sourceIds])) as Array<number | string>).map(Number);

export const countUnfilledAttribution: StoreMember<[table: AttributionTable, sourceIds: readonly string[]], number> = async (brain, table, sourceIds) =>
  Number(await storeCall({ member: 'countUnfilledAttribution' }, () => brain.countUnfilledAttribution(table, [...sourceIds])));

export const listFailedWriteRequests: StoreMember<[sourceIds: readonly string[], query: FailedWriteQuery], FailedWriteRow[]> = async (brain, sourceIds, query) =>
  await storeCall({ member: 'listFailedWriteRequests' }, () => brain.listFailedWriteRequests([...sourceIds], [...query.replayable],
    query.factsMovedMessages ? [...query.factsMovedMessages] : null, query.id ?? null)) as FailedWriteRow[];

export const readDriftConflictBounds: StoreMember<[sourceId: string], DriftConflictBounds | null> = async (brain, sourceId) =>
  await storeCall({ member: 'readDriftConflictBounds', sourceId }, () => brain.readDriftConflictBounds(sourceId)) as DriftConflictBounds | null;

export const listDriftConflictGroups: StoreMember<[sourceId: string, query: DriftConflictQuery], DriftConflictGroups> = async (brain, sourceId, query) => {
  const excludePrivate = query.excludePrivate
    ? storePageTextPolicy('listDriftConflictGroups', () => remoteReadFloorSql('p'), { callerReaders: true }) : null;
  const groups = await storeCall({ member: 'listDriftConflictGroups', sourceId }, () => brain.listDriftConflictGroups(sourceId, {
    incarnation: query.incarnation, floor: query.floor, through: query.through, slug_prefixes: query.slugPrefixes ? [...query.slugPrefixes] : null,
    require_live_page: query.requireLivePage, exclude_private: excludePrivate, after: query.after, limit: query.limit, drift_message: query.driftMessage,
  })) as DriftConflictGroups;
  return { slugs: Number(groups.slugs), receipts: Number(groups.receipts), rows: groups.rows };
};

export const readDriftConflictDetails: StoreMember<[sourceId: string, slugs: readonly string[], opts: { paths: boolean }], DriftConflictDetails> =
  async (brain, sourceId, slugs, opts) => {
    if (!slugs.length) return { committed: [], recorded: [] };
    return await storeCall({ member: 'readDriftConflictDetails', sourceId }, () =>
      brain.readDriftConflictDetails(sourceId, [...slugs], opts.paths)) as DriftConflictDetails;
  };
