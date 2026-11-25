/**
 * The extract_facts fence reconcile and deleted-page expiry (BrainEngine listFenceRowSupersession, setFactSupersededBy,
 * expireFactInPlace, expireAndDetachFact, updateFenceFactCells, listHeldWideningFactIds,
 * listDeletedPageSlugsWithActiveFacts, listExpirableFactIdsOfDeletedPage, readDeletedPageBody, expireFactsByIds;
 * src/core/engine-sql/facts-cycle.ts), served from the facts store (rust/crates/gbrain-store/src/facts/cycle_fence.rs).
 *
 * Each member makes one store call with the arguments of its statement. `listFenceRowSupersession` turns the
 * `expired_at` text the store returns into a `Date`, as PGLite returns it.
 */
import type { BrainEngine } from '../../engine.ts';
import { storeCall, type StoreMember } from './common.ts';
import { withDates } from '../store-codec.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

export const listFenceRowSupersession: Member<'listFenceRowSupersession'> = async (brain, sourceId, slug) => {
  const rows: Array<Record<string, unknown>> = await storeCall({ member: 'listFenceRowSupersession' }, () => brain.listFenceRowSupersession({ sourceId, slug }));
  return rows.map((row) => withDates(row, ['expired_at'])) as unknown as Awaited<ReturnType<BrainEngine['listFenceRowSupersession']>>;
};

export const setFactSupersededBy: Member<'setFactSupersededBy'> = async (brain, sourceId, id, supersededBy) => {
  await storeCall({ member: 'setFactSupersededBy' }, () => brain.setFactSupersededBy({ sourceId, id: Number(id), supersededBy }));
};

export const expireFactInPlace: Member<'expireFactInPlace'> = async (brain, sourceId, id) => {
  await storeCall({ member: 'expireFactInPlace' }, () => brain.expireFactInPlace({ sourceId, id: Number(id) }));
};

export const expireAndDetachFact: Member<'expireAndDetachFact'> = async (brain, sourceId, id) => {
  await storeCall({ member: 'expireAndDetachFact' }, () => brain.expireAndDetachFact({ sourceId, id: Number(id) }));
};

export const updateFenceFactCells: Member<'updateFenceFactCells'> = async (brain, sourceId, id, cells) => {
  await storeCall({ member: 'updateFenceFactCells' }, () => brain.updateFenceFactCells({ sourceId, id: Number(id), ...cells }));
};

export const listHeldWideningFactIds: Member<'listHeldWideningFactIds'> = (brain, sourceId, ids) =>
  storeCall({ member: 'listHeldWideningFactIds' }, () => brain.listHeldWideningFactIds({ sourceId, ids: ids.map(Number) }));

export const listDeletedPageSlugsWithActiveFacts: Member<'listDeletedPageSlugsWithActiveFacts'> = (brain, sourceId) =>
  storeCall({ member: 'listDeletedPageSlugsWithActiveFacts' }, () => brain.listDeletedPageSlugsWithActiveFacts(sourceId));

export const listExpirableFactIdsOfDeletedPage: Member<'listExpirableFactIdsOfDeletedPage'> = (brain, sourceId, slug, pageId) =>
  storeCall({ member: 'listExpirableFactIdsOfDeletedPage' }, () => brain.listExpirableFactIdsOfDeletedPage({ sourceId, slug, pageId }));

export const readDeletedPageBody: Member<'readDeletedPageBody'> = (brain, sourceId, slug) =>
  storeCall({ member: 'readDeletedPageBody' }, () => brain.readDeletedPageBody({ sourceId, slug }));

export const expireFactsByIds: Member<'expireFactsByIds'> = (brain, sourceId, ids) =>
  storeCall({ member: 'expireFactsByIds' }, () => brain.expireFactsByIds({ sourceId, ids: ids.map(Number) }));
