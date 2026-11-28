/**
 * The page write guards (BrainEngine readPageOrigin, listRevivalPages, listOriginClaims, bindPageOrigin, stampPageIngest,
 * sealImportedPage, detachPageOrigin, readPageDatabaseOnlyReason, bumpPageKnowledgeRevision, removePageFrontmatterKeys, setPageType, readLivePageBody, readPageIndexingState, readInlinePageRegions, readStoredPageTier, hasSegmentStorage): the reads and
 * writes a page write runs around the page row (engine-sql/write-guards.ts on the SQL engines). The store runs one
 * write transaction at a time, so the advisory locks PGLite takes before it lists origin claims are already held,
 * and `listOriginClaims` takes none.
 *
 * What each member answers and why: rust/docs/store/write-guards.md.
 */
import type { ImportedPageSeal, InlinePageRegionsRow, LivePageBodyRow, OriginClaimRow, PageIndexingState, PageIngestStamp, PageOriginRow, PageOriginTarget, RevivalPageRow } from '../../engine-sql/write-guards.ts';
import type { StoredBodyRow } from '../../engine-sql/facts-cycle.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';

/** The page a target names, live or a tombstone. `deleted_at` comes back as a Date, as PGLite returns a timestamptz. */
export const readPageOrigin: StoreMember<[target: PageOriginTarget], PageOriginRow | null> = async (brain, target) => {
  const row = await storeCall({ member: 'readPageOrigin', slug: target.slug ?? undefined, sourceId: target.sourceId },
    () => brain.readPageOrigin({ sourceId: target.sourceId, pageId: target.pageId ?? null, slug: target.slug ?? null })) as
    { id: number; slug: string; source_path: string | null; deleted_at: string | null } | null;
  return row && { id: Number(row.id), slug: row.slug, source_path: row.source_path, deleted_at: row.deleted_at === null ? null : new Date(row.deleted_at) };
};

/** The tombstones a restore of `slug` revives, by source id in byte order. */
export const listRevivalPages: StoreMember<[slug: string, sourceId: string | null], RevivalPageRow[]> = async (brain, slug, sourceId) =>
  ((await storeCall({ member: 'listRevivalPages', slug, sourceId: sourceId ?? undefined }, () => brain.listRevivalPages(slug, sourceId))) as Array<{ id: number; source_id: string }>)
    .map(row => ({ id: Number(row.id), source_id: row.source_id }));

export const listOriginClaims: StoreMember<[sourceId: string, spellings: readonly string[], opts: { lockKeys: readonly string[]; excludePageId?: number | null }], OriginClaimRow[]> =
  (brain, sourceId, spellings, opts) => storeCall({ member: 'listOriginClaims', sourceId },
    () => brain.listOriginClaims(sourceId, [...spellings], { lockKeys: [...opts.lockKeys], excludePageId: opts.excludePageId ?? null }));

/** The store refuses an origin another live page records with `origin_claimed`, as PGLite's unique index does. */
export const bindPageOrigin: StoreMember<[target: PageOriginTarget & { sourcePath: string; onlyIfUnset?: boolean; liveOnly?: boolean }], number> =
  async (brain, target) => Number(await storeCall({ member: 'bindPageOrigin', slug: target.slug ?? undefined, sourceId: target.sourceId },
    () => brain.bindPageOrigin({
      sourceId: target.sourceId, pageId: target.pageId ?? null, slug: target.slug ?? null, sourcePath: target.sourcePath,
      onlyIfUnset: target.onlyIfUnset === true, liveOnly: target.liveOnly === true,
    })));

/** `ingestedAt` goes to the store as `Date#toISOString` (millisecond precision); an unparsable time throws, as the cast does. */
export const stampPageIngest: StoreMember<[slug: string, stamp: PageIngestStamp], void> = async (brain, slug, stamp) => {
  const at = stamp.ingestedAt == null ? null : new Date(stamp.ingestedAt);
  if (at && Number.isNaN(at.getTime())) throw new Error(`stampPageIngest: invalid ingested_at ${JSON.stringify(stamp.ingestedAt)}`);
  await storeCall({ member: 'stampPageIngest', slug, sourceId: stamp.sourceId }, () => brain.stampPageIngest(slug, {
    sourceId: stamp.sourceId, sourceKind: stamp.sourceKind ?? null, ingestedVia: stamp.ingestedVia ?? null, ingestedAt: at?.toISOString() ?? null, keepIngestedAt: stamp.keepIngestedAt === true,
  }));
};

export const sealImportedPage: StoreMember<[slug: string, seal: ImportedPageSeal], { id: number } | null> = async (brain, slug, seal) => {
  const row = await storeCall({ member: 'sealImportedPage', slug, sourceId: seal.sourceId }, () => brain.sealImportedPage(slug, {
    sourceId: seal.sourceId, revision: seal.revision ?? null, timelineText: seal.timelineText, chunkerVersion: seal.chunkerVersion,
  })) as { id: number } | null;
  return row && { id: Number(row.id) };
};

export const readLivePageBody: StoreMember<[slug: string, opts: { sourceId: string }], LivePageBodyRow | null> = (brain, slug, opts) =>
  storeCall({ member: 'readLivePageBody', slug, sourceId: opts.sourceId }, () => brain.readLivePageBody(slug, opts.sourceId));

/**
 * `readLiveStoredBody` (engine-sql/facts-cycle.ts): the body columns of `readLivePageBody`. `lock` takes nothing: the
 * store runs one write transaction at a time, so no other writer changes the row under the caller's transaction.
 */
export const readLiveStoredBody: StoreMember<[sourceId: string, slug: string, lock?: boolean], StoredBodyRow | null> = async (brain, sourceId, slug) => {
  const row = await storeCall({ member: 'readLiveStoredBody', slug, sourceId }, () => brain.readLivePageBody(slug, sourceId)) as LivePageBodyRow | null;
  return row && { compiled_truth: row.compiled_truth, timeline: row.timeline };
};

export const readPageIndexingState: StoreMember<[pageId: number], PageIndexingState | null> = (brain, pageId) =>
  storeCall({ member: 'readPageIndexingState' }, () => brain.readPageIndexingState(pageId)) as Promise<PageIndexingState | null>;
/** A page id that is not a positive integer names no page: null, as PGLite's `WHERE id=$1` matches none (a fraction refuses). */
export const readInlinePageRegions: StoreMember<[pageId: number], InlinePageRegionsRow | null> = async (brain, pageId) => {
  if (!Number.isSafeInteger(pageId)) refuseMember('readInlinePageRegions', 'a page id that is not an integer');
  if (pageId < 1) return null;
  return storeCall({ member: 'readInlinePageRegions' }, () => brain.readInlinePageRegions(pageId));
};

export const readStoredPageTier: StoreMember<[sourceId: string, slug: string], string | null> = (brain, sourceId, slug) =>
  storeCall({ member: 'readStoredPageTier', slug, sourceId }, () => brain.readStoredPageTier(sourceId, slug));

/** True once a segment text or a body staging is stored; the store keeps neither until the page-body family lands. */
export const hasSegmentStorage: StoreMember<[], boolean> = (brain) => storeCall({ member: 'hasSegmentStorage' }, () => brain.hasSegmentStorage());

/** A page id that is not a positive integer names no page: nothing changes, as PGLite's `WHERE id=$1` matches none. */
const pageIdOf = (member: string, pageId: number): number | null => {
  if (!Number.isSafeInteger(pageId)) refuseMember(member, 'a page id that is not an integer');
  return pageId < 1 ? null : pageId;
};

export const detachPageOrigin: StoreMember<[pageId: number, reason: string], void> = async (brain, pageId, reason) => {
  const id = pageIdOf('detachPageOrigin', pageId);
  if (id !== null) await storeCall({ member: 'detachPageOrigin' }, () => brain.detachPageOrigin(id, reason));
};

export const readPageDatabaseOnlyReason: StoreMember<[sourceId: string, slug: string], string | null> = (brain, sourceId, slug) =>
  storeCall({ member: 'readPageDatabaseOnlyReason', slug, sourceId }, () => brain.readPageDatabaseOnlyReason(sourceId, slug));

export const bumpPageKnowledgeRevision: StoreMember<[pageId: number], void> = async (brain, pageId) => {
  const id = pageIdOf('bumpPageKnowledgeRevision', pageId);
  if (id !== null) await storeCall({ member: 'bumpPageKnowledgeRevision' }, () => brain.bumpPageKnowledgeRevision(id));
};

export const removePageFrontmatterKeys: StoreMember<[sourceId: string, pageId: number, keys: readonly string[]], void> = async (brain, sourceId, pageId, keys) => {
  const id = pageIdOf('removePageFrontmatterKeys', pageId);
  if (id !== null) await storeCall({ member: 'removePageFrontmatterKeys', sourceId }, () => brain.removePageFrontmatterKeys(sourceId, id, [...keys]));
};

export const setPageType: StoreMember<[sourceId: string, slug: string, type: string], void> = async (brain, sourceId, slug, type) => {
  await storeCall({ member: 'setPageType', slug, sourceId }, () => brain.setPageType(sourceId, slug, type));
};
