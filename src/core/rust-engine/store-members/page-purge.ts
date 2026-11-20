/**
 * The reads and tombstone edits of a page purge (BrainEngine listPurgeClaimFacts, listPurgeClaimTakes,
 * listPurgeSegmentClaims, listQueuedPagePurges, listPageLinkStreams, insertPageFactPurges, listPageVersionBodiesForPurge,
 * readPurgePageBody, listPageMirrorFacts, listPageMirrorTakeHashes, countPageCascadeRows, listPageVersionSourcePaths,
 * listPagePurgeTombstones, listPagePurgeRows, deletePagePurgeTombstones, deleteFactPurgesByRequests and
 * deleteTakePurgesByRequests; SQL in engine-sql/page-purge.ts), served from the store's fact, take, link, version, chunk,
 * timeline and journal records and its page, fact and take purge ledgers (gbrain-store `facts/page_purge_reads.rs`,
 * `facts/page_purges.rs`, `facts/purge_ledger.rs`, `facts/take_purges.rs`; rust/docs/store/facts.md).
 *
 * Each member sends the arguments of its BrainEngine member; the store call keeps its own name (snake case in the
 * store). The members whose SQL has no order (`DISTINCT`, `UNION`) answer sorted by the same comparator as the SQL
 * engines' functions (`byText`). The page-tombstone delete takes no row lock: the store admits one write transaction
 * at a time, as `lockSourceRow` notes, so the transaction `unpurgePage` opens already serializes its writers.
 */
import type { BrainEngine } from '../../engine.ts';
import { byText } from '../../engine-sql/page-purge.ts';
import { storeCall, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

export const listPurgeClaimFacts: Member<'listPurgeClaimFacts'> = (brain, sourceId, slug) =>
  storeCall({ member: 'listPurgeClaimFacts', sourceId }, () => brain.listPurgeClaimFacts(sourceId, slug));

export const listPurgeClaimTakes: Member<'listPurgeClaimTakes'> = (brain, pageId) =>
  storeCall({ member: 'listPurgeClaimTakes' }, () => brain.listPurgeClaimTakes(pageId));

export const listPurgeSegmentClaims: Member<'listPurgeSegmentClaims'> = async (brain, sourceId, slug, pageId) =>
  ((await storeCall({ member: 'listPurgeSegmentClaims', sourceId }, () => brain.listPurgeSegmentClaims(sourceId, slug, pageId))) as string[]).sort(byText);

export const listQueuedPagePurges: Member<'listQueuedPagePurges'> = (brain, sourceId, afterSequence, limit) =>
  storeCall({ member: 'listQueuedPagePurges', sourceId }, () => brain.listQueuedPagePurges(sourceId, afterSequence, limit));

export const listPageLinkStreams: Member<'listPageLinkStreams'> = async (brain, sourceId, pageId) =>
  ((await storeCall({ member: 'listPageLinkStreams', sourceId }, () => brain.listPageLinkStreams(sourceId, pageId))) as string[]).sort(byText);

export const insertPageFactPurges: Member<'insertPageFactPurges'> = async (brain, sourceId, slug, requestId, actor) => {
  await storeCall({ member: 'insertPageFactPurges', sourceId }, () => brain.insertPageFactPurges(sourceId, slug, requestId, actor));
};

export const listPageVersionBodiesForPurge: Member<'listPageVersionBodiesForPurge'> = (brain, pageId) =>
  storeCall({ member: 'listPageVersionBodiesForPurge' }, () => brain.listPageVersionBodiesForPurge(pageId));

export const readPurgePageBody: Member<'readPurgePageBody'> = (brain, pageId) =>
  storeCall({ member: 'readPurgePageBody' }, () => brain.readPurgePageBody(pageId));

export const listPageMirrorFacts: Member<'listPageMirrorFacts'> = (brain, sourceId, slug) =>
  storeCall({ member: 'listPageMirrorFacts', sourceId }, () => brain.listPageMirrorFacts(sourceId, slug));

export const listPageMirrorTakeHashes: Member<'listPageMirrorTakeHashes'> = async (brain, pageId) =>
  ((await storeCall({ member: 'listPageMirrorTakeHashes' }, () => brain.listPageMirrorTakeHashes(pageId))) as string[]).sort(byText);

export const countPageCascadeRows: Member<'countPageCascadeRows'> = (brain, pageId) =>
  storeCall({ member: 'countPageCascadeRows' }, () => brain.countPageCascadeRows(pageId));

export const listPageVersionSourcePaths: Member<'listPageVersionSourcePaths'> = async (brain, pageId) =>
  ((await storeCall({ member: 'listPageVersionSourcePaths' }, () => brain.listPageVersionSourcePaths(pageId))) as string[]).sort(byText);

export const listPagePurgeTombstones: Member<'listPagePurgeTombstones'> = (brain, sourceId, limit) =>
  storeCall({ member: 'listPagePurgeTombstones', sourceId }, () => brain.listPagePurgeTombstones(sourceId, limit));

export const listPagePurgeRows: Member<'listPagePurgeRows'> = (brain, sourceId, limit) =>
  storeCall({ member: 'listPagePurgeRows', ...(sourceId === null ? {} : { sourceId }) }, () => brain.listPagePurgeRows(sourceId, limit));

export const deletePagePurgeTombstones: Member<'deletePagePurgeTombstones'> = (brain, sourceId, slug) =>
  storeCall({ member: 'deletePagePurgeTombstones', sourceId }, () => brain.deletePagePurgeTombstones(sourceId, slug));

export const deleteFactPurgesByRequests: Member<'deleteFactPurgesByRequests'> = (brain, sourceId, requestIds) =>
  storeCall({ member: 'deleteFactPurgesByRequests', sourceId }, () => brain.deleteFactPurgesByRequests(sourceId, [...requestIds]));

export const deleteTakePurgesByRequests: Member<'deleteTakePurgesByRequests'> = (brain, sourceId, requestIds) =>
  storeCall({ member: 'deleteTakePurgesByRequests', sourceId }, () => brain.deleteTakePurgesByRequests(sourceId, [...requestIds]));
