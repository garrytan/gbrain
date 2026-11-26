/**
 * The deletes and reads of a page purge's sweep, its segment storage and its slug stores (BrainEngine deletePurgedPageTrustProposals, deletePurgedPageHolds,
 * deletePurgedPageGateReceipts, deletePurgedPageFacts, deletePurgedPageFiles, listPageTimelineReceipts, listPageSegmentShas,
 * countPageManifestRows, deletePageStagings, deletePageSegmentTexts, sweepPageTextsForClaims, listPageChangeReasons,
 * listRequestsRecordingReasons, deletePurgedSlugStoreRows and listPageSecretOccurrences; SQL in engine-sql/page-purge-sweep.ts,
 * facts-purge.ts and purge-slug-stores.ts), served from the store's decide, trust, write-gate, fact, file, journal, version,
 * page-body, take-proposal, loop and alias records (gbrain-store `eval_capture/decide_proposals/purge.rs`,
 * `trust/proposals/purge.rs`, `trust/write_gate/purge.rs`, `facts/page_purge_sweep.rs`, `facts/page_purge_journal.rs`,
 * `raw_files/purge.rs`, `page_body/purge_sweep.rs`; rust/docs/store/facts.md).
 *
 * Each member sends the arguments of its BrainEngine member; the store call keeps its own name (snake case in the store). The
 * members whose SQL has no order (`RETURNING`, `UNION`) answer sorted by the same comparator as the SQL engines' functions
 * (`byText`, `byId`). The deletes take no row lock: the store admits one write transaction at a time, so the transaction a
 * purge opens already serializes its writers.
 *
 * Answered here, without a store call, because the store keeps no such rows:
 * - `listPageSecretOccurrences`: the store keeps no secret store, so a page holds no occurrence.
 * `deletePurgedSlugStoreRows` deletes the page's core edit notices in the store and counts them under `core_edit_notices`; it
 * answers `secretStore: false`, so the purge has no secret store to scrub (persistence/purge-slug-stores.ts).
 */
import type { BrainEngine } from '../../engine.ts';
import { byId } from '../../engine-sql/page-purge-sweep.ts';
import { byText } from '../../engine-sql/page-purge.ts';
import { storeCall, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

export const deletePurgedPageTrustProposals: Member<'deletePurgedPageTrustProposals'> = (brain, sourceId, pageId, factIds, takeIds) =>
  storeCall({ member: 'deletePurgedPageTrustProposals', sourceId }, () => brain.deletePurgedPageTrustProposals(sourceId, pageId, [...factIds], [...takeIds]));

export const deletePurgedPageHolds: Member<'deletePurgedPageHolds'> = async (brain, sourceId, slug) =>
  ((await storeCall({ member: 'deletePurgedPageHolds', sourceId }, () => brain.deletePurgedPageHolds(sourceId, slug))) as string[]).sort(byId);

export const deletePurgedPageGateReceipts: Member<'deletePurgedPageGateReceipts'> = (brain, pageId, factIds, takeIds, holdIds) =>
  storeCall({ member: 'deletePurgedPageGateReceipts' }, () => brain.deletePurgedPageGateReceipts(pageId, [...factIds], [...takeIds], [...holdIds]));

export const deletePurgedPageFacts: Member<'deletePurgedPageFacts'> = (brain, sourceId, slug) =>
  storeCall({ member: 'deletePurgedPageFacts', sourceId }, () => brain.deletePurgedPageFacts(sourceId, slug));

export const deletePurgedPageFiles: Member<'deletePurgedPageFiles'> = async (brain, sourceId, slug, pageId) =>
  ((await storeCall({ member: 'deletePurgedPageFiles', sourceId }, () => brain.deletePurgedPageFiles(sourceId, slug, pageId))) as string[]).sort(byText);

export const listPageTimelineReceipts: Member<'listPageTimelineReceipts'> = (brain, sourceId, slugs, limit, after, withDiffs) =>
  storeCall({ member: 'listPageTimelineReceipts', sourceId }, () => brain.listPageTimelineReceipts(sourceId, [...slugs], limit, after, withDiffs));

export const listPageSegmentShas: Member<'listPageSegmentShas'> = async (brain, sourceId, slug, pageId) =>
  ((await storeCall({ member: 'listPageSegmentShas', sourceId }, () => brain.listPageSegmentShas(sourceId, slug, pageId))) as string[]).sort(byText);

export const countPageManifestRows: Member<'countPageManifestRows'> = (brain, pageId) =>
  storeCall({ member: 'countPageManifestRows' }, () => brain.countPageManifestRows(pageId));

export const deletePageStagings: Member<'deletePageStagings'> = (brain, sourceId, slug, pageId) =>
  storeCall({ member: 'deletePageStagings', sourceId }, () => brain.deletePageStagings(sourceId, slug, pageId));

export const deletePageSegmentTexts: Member<'deletePageSegmentTexts'> = (brain, sourceId, shas) =>
  storeCall({ member: 'deletePageSegmentTexts', sourceId }, () => brain.deletePageSegmentTexts(sourceId, [...shas]));

export const sweepPageTextsForClaims: Member<'sweepPageTextsForClaims'> = async (brain, sourceId, cursor, forms, chunkBytes) => {
  const swept = await storeCall({ member: 'sweepPageTextsForClaims', sourceId }, () => brain.sweepPageTextsForClaims(sourceId, cursor, [...forms], chunkBytes)) as { last: string | null; deleted: string[] };
  return { last: swept.last, deleted: [...swept.deleted].sort(byText) };
};

/** NULL first, then the reasons in text order: the sort `listPageChangeReasons` gives every engine. */
const nullsFirst = (a: { reason: string | null }, b: { reason: string | null }): number =>
  a.reason === b.reason ? 0 : a.reason === null ? -1 : b.reason === null ? 1 : byText(a.reason, b.reason);

export const listPageChangeReasons: Member<'listPageChangeReasons'> = async (brain, sourceId, slug, pageId) =>
  ((await storeCall({ member: 'listPageChangeReasons', sourceId }, () => brain.listPageChangeReasons(sourceId, slug, pageId))) as Array<{ reason: string | null }>).sort(nullsFirst);

export const listRequestsRecordingReasons: Member<'listRequestsRecordingReasons'> = (brain, sourceId, slug) =>
  storeCall({ member: 'listRequestsRecordingReasons', sourceId }, () => brain.listRequestsRecordingReasons(sourceId, slug));

/** `ifPresent` changes nothing here: every store the scrub names exists, and the ones the store does not keep answer 0 (`core_edit_notices` is counted from the store's notice rows). */
export const deletePurgedSlugStoreRows: Member<'deletePurgedSlugStoreRows'> = (brain, sourceId, slugs) =>
  storeCall({ member: 'deletePurgedSlugStoreRows', sourceId }, () => brain.deletePurgedSlugStoreRows(sourceId, [...slugs]));

/** The store keeps no secret store, so no page holds a secret occurrence. */
export const listPageSecretOccurrences: Member<'listPageSecretOccurrences'> = async () => [];
