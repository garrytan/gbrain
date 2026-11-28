/**
 * The page-write guards of engine-sql/write-guards.ts the store serves (gbrain-store `write_guards`).
 *
 * Export only BrainEngine members from this file: index.ts spreads the whole module into STORE_MEMBERS.
 */
import type { ImportedPageSeal } from '../../engine-sql/write-guards.ts';
import { storeCall, type StoreMember } from './common.ts';
import type { LivePageBodyRow, PageIndexingState, PageOriginRow, PageOriginTarget } from '../../engine-sql/write-guards.ts';

/** Seals an imported page: the revision, the timeline text and the chunker version; the sealed page's id, or null. */
export const sealImportedPage: StoreMember<[slug: string, seal: ImportedPageSeal], { id: number } | null> = async (brain, slug, seal) => {
  const row = await storeCall({ member: 'sealImportedPage', slug, sourceId: seal.sourceId }, () => brain.sealImportedPage(slug, {
    sourceId: seal.sourceId, revision: seal.revision ?? null, timelineText: seal.timelineText, chunkerVersion: seal.chunkerVersion,
  })) as { id: number } | null;
  return row && { id: Number(row.id) };
};

/** True once a segment text or a body staging is stored; the store keeps neither until the page-body family lands. */
export const hasSegmentStorage: StoreMember<[], boolean> = (brain) => storeCall({ member: 'hasSegmentStorage' }, () => brain.hasSegmentStorage());

export const readLivePageBody: StoreMember<[slug: string, opts: { sourceId: string }], LivePageBodyRow | null> = (brain, slug, opts) =>
  storeCall({ member: 'readLivePageBody', slug, sourceId: opts.sourceId }, () => brain.readLivePageBody(slug, opts.sourceId));

export const readStoredPageTier: StoreMember<[sourceId: string, slug: string], string | null> = (brain, sourceId, slug) =>
  storeCall({ member: 'readStoredPageTier', slug, sourceId }, () => brain.readStoredPageTier(sourceId, slug));

export const readPageIndexingState: StoreMember<[pageId: number], PageIndexingState | null> = (brain, pageId) =>
  storeCall({ member: 'readPageIndexingState' }, () => brain.readPageIndexingState(pageId)) as Promise<PageIndexingState | null>;

/** The page `target` names, live or a tombstone, by id within the source or by its exact slug; null when there is none. */
export const readPageOrigin: StoreMember<[target: PageOriginTarget], PageOriginRow | null> = async (brain, target) => {
  // No page has a negative id; the store's id is unsigned, so such a target answers null, as the SQL read does.
  if (target.pageId != null && target.pageId < 0) return null;
  const row = await storeCall({ member: 'readPageOrigin', slug: target.slug ?? undefined, sourceId: target.sourceId }, () => brain.readPageOrigin({
    sourceId: target.sourceId, ...(target.pageId != null ? { pageId: target.pageId } : {}), ...(target.slug ? { slug: target.slug } : {}),
  })) as PageOriginRow | null;
  return row && { ...row, id: Number(row.id) };
};
