/**
 * The phantom redirect's fact, page, timeline and link members (BrainEngine listPhantomFactRows,
 * listCanonicalFenceRowNums, moveFactToPage, listActiveFactIdsOfPage, listFactIdsStillOnPage, listRootPageSlugsAfter,
 * listOntologyObservationSlugs, pageHasTimelineEntries, maxFenceRowNumOfPage, readFenceRowNumHint, listOwnLinkIds,
 * listLinkIdsOnPage, repointInboundLinks, repointOutboundLinks; src/core/engine-sql/facts-cycle.ts), served from the
 * facts store (rust/crates/gbrain-store/src/facts/phantom.rs) and the links store (links/phantom_merge.rs).
 *
 * Each member makes one store call with the arguments of its statement. `maxFenceRowNumOfPage` and
 * `readFenceRowNumHint` run the same `MAX(row_num)` statement as `maxFenceRowNum` (facts/cycle.rs). A page id that
 * arrives as text is sent as a number; text that is not a number refuses in the store as PGLite's cast does.
 */
import type { BrainEngine } from '../../engine.ts';
import { storeCall, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

export const listPhantomFactRows: Member<'listPhantomFactRows'> = (brain, sourceId, slug) =>
  storeCall({ member: 'listPhantomFactRows' }, () => brain.listPhantomFactRows({ sourceId, slug }));

export const listCanonicalFenceRowNums: Member<'listCanonicalFenceRowNums'> = (brain, sourceId, slug) =>
  storeCall({ member: 'listCanonicalFenceRowNums' }, () => brain.listCanonicalFenceRowNums({ sourceId, slug }));

export const listActiveFactIdsOfPage: Member<'listActiveFactIdsOfPage'> = (brain, sourceId, slug) =>
  storeCall({ member: 'listActiveFactIdsOfPage' }, () => brain.listActiveFactIdsOfPage({ sourceId, slug }));

export const listFactIdsStillOnPage: Member<'listFactIdsStillOnPage'> = (brain, ids, slug) =>
  storeCall({ member: 'listFactIdsStillOnPage' }, () => brain.listFactIdsStillOnPage({ ids: ids.map(Number), slug }));

export const moveFactToPage: Member<'moveFactToPage'> = async (brain, sourceId, id, slug, rowNum) => {
  await storeCall({ member: 'moveFactToPage' }, () =>
    brain.moveFactToPage({ sourceId, id: Number(id), slug, rowNum: rowNum === null || rowNum === undefined ? null : Number(rowNum) }));
};

export const listOntologyObservationSlugs: Member<'listOntologyObservationSlugs'> = (brain, sourceId) =>
  storeCall({ member: 'listOntologyObservationSlugs' }, () => brain.listOntologyObservationSlugs(sourceId));

export const listRootPageSlugsAfter: Member<'listRootPageSlugsAfter'> = (brain, sourceId, take, held, after) =>
  storeCall({ member: 'listRootPageSlugsAfter' }, () => brain.listRootPageSlugsAfter({ sourceId, take: Number(take), held: [...held], after }));

export const pageHasTimelineEntries: Member<'pageHasTimelineEntries'> = (brain, pageId) =>
  storeCall({ member: 'pageHasTimelineEntries' }, () => brain.pageHasTimelineEntries(pageId === null ? null : Number(pageId)));

export const maxFenceRowNumOfPage: Member<'maxFenceRowNumOfPage'> = (brain, sourceId, slug) =>
  storeCall({ member: 'maxFenceRowNumOfPage' }, () => brain.maxFenceRowNum({ sourceId, slug }));

export const readFenceRowNumHint: Member<'readFenceRowNumHint'> = (brain, sourceId, slug) =>
  storeCall({ member: 'readFenceRowNumHint' }, () => brain.maxFenceRowNum({ sourceId, slug }));

export const listOwnLinkIds: Member<'listOwnLinkIds'> = (brain, pageId) =>
  storeCall({ member: 'listOwnLinkIds' }, () => brain.listOwnLinkIds(Number(pageId)));

export const listLinkIdsOnPage: Member<'listLinkIdsOnPage'> = (brain, ids, pageId) =>
  storeCall({ member: 'listLinkIdsOnPage' }, () => brain.listLinkIdsOnPage({ ids: ids.map(Number), pageId: Number(pageId) }));

export const repointInboundLinks: Member<'repointInboundLinks'> = async (brain, phantomId, canonicalId) => {
  await storeCall({ member: 'repointInboundLinks' }, () =>
    brain.repointInboundLinks({ phantomId: Number(phantomId), canonicalId: Number(canonicalId) }));
};

export const repointOutboundLinks: Member<'repointOutboundLinks'> = async (brain, phantomId, canonicalId) => {
  await storeCall({ member: 'repointOutboundLinks' }, () =>
    brain.repointOutboundLinks({ phantomId: Number(phantomId), canonicalId: Number(canonicalId) }));
};
