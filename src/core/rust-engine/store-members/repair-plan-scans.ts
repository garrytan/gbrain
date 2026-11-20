/**
 * The plan reads of the frontmatter and segmented-tiling repairs and the source hold listing (BrainEngine
 * listPagesByOriginPath through listSourceHoldRecords, the statements of engine-sql/repair-plan-scans.ts). The store scans
 * its page, body and checkpoint records as the SQL filters its rows (rust/crates/gbrain-store/src/repair_plan_scans.rs).
 */
import {
  untiledPageOf, type OriginPathPageRow, type SourceHoldQuery, type SourceHoldRecordRow, type UntiledPage, type UntiledPageQuery, type UntiledPageRow,
} from '../../engine-sql/repair-plan-scans.ts';
import { storeCall, type StoreMember } from './common.ts';

export const listPagesByOriginPath: StoreMember<[sourceId: string], OriginPathPageRow[]> = async (brain, sourceId) =>
  await storeCall({ member: 'listPagesByOriginPath', sourceId }, () => brain.listPagesByOriginPath(sourceId)) as OriginPathPageRow[];

export const countSegmentedOriginPages: StoreMember<[sourceIds: readonly string[]], number> = async (brain, sourceIds) =>
  Number(await storeCall({ member: 'countSegmentedOriginPages' }, () => brain.countSegmentedOriginPages([...sourceIds])));

export const listUntiledSegmentedPages: StoreMember<[opts?: UntiledPageQuery], UntiledPage[]> = async (brain, opts = {}) => {
  const limit = Math.max(0, Math.floor(opts.limit ?? 1000));
  const rows = await storeCall({ member: 'listUntiledSegmentedPages' }, () =>
    brain.listUntiledSegmentedPages(opts.sourceIds ? [...opts.sourceIds] : null, opts.slugs ? [...opts.slugs] : null, limit)) as UntiledPageRow[];
  return rows.map(untiledPageOf);
};

export const listSourceHoldRecords: StoreMember<[op: string, opts?: SourceHoldQuery], SourceHoldRecordRow[]> = async (brain, op, opts = {}) =>
  await storeCall({ member: 'listSourceHoldRecords' }, () =>
    brain.listSourceHoldRecords(op, opts.sourceIds ? [...opts.sourceIds] : null, opts.runId ?? null)) as SourceHoldRecordRow[];
