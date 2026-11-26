/**
 * The Git-gap census reads (BrainEngine readGitGapSourceRow ... readGitGapSourceRows; SQL in engine-sql/git-gap-census.ts),
 * served from the store's records (rust/crates/gbrain-store/src/git_gap_census.rs, rust/docs/store/git-gap-census.md).
 */
import type { GitGapBatch, GitGapPageRow, GitGapSourceRow, GitGapSourceRows } from '../../engine-sql/git-gap-census.ts';
import { privacyPartAliases } from './private-provenance.ts';
import { storeCall, type StoreMember } from './common.ts';

export const readGitGapSourceRow: StoreMember<[sourceId: string], GitGapSourceRow | null> = async (brain, sourceId) =>
  await storeCall({ member: 'readGitGapSourceRow', sourceId }, () => brain.readGitGapSourceRow(sourceId)) as GitGapSourceRow | null;

export const countGitGapLivePages: StoreMember<[sourceId: string], number> = async (brain, sourceId) =>
  Number(await storeCall({ member: 'countGitGapLivePages', sourceId }, () => brain.countGitGapLivePages(sourceId)));

/** The store's transaction admits no other writer while it runs, and the census writes nothing inside it: nothing to set. */
export const markTransactionReadOnly: StoreMember<[], void> = async () => {};

export const listGitGapNewestPages: StoreMember<[sourceId: string, limit: number], Array<{ id: string; updated_at: string }>> = async (brain, sourceId, limit) =>
  await storeCall({ member: 'listGitGapNewestPages', sourceId }, () => brain.listGitGapNewestPages(sourceId, limit)) as Array<{ id: string; updated_at: string }>;

export const countGitGapUnreadFacts: StoreMember<[sourceId: string, pageIds: readonly string[]], number> = async (brain, sourceId, pageIds) =>
  Number(await storeCall({ member: 'countGitGapUnreadFacts', sourceId }, () => brain.countGitGapUnreadFacts(sourceId, [...pageIds])));

/** The privacy part's honor-aliases setting is read from the text privacyPartSql renders now, as the SQL engines send it. */
export const readGitGapPageBatch: StoreMember<[sourceId: string, batch: GitGapBatch], GitGapPageRow[]> = async (brain, sourceId, batch) => {
  const honorAliases = privacyPartAliases('readGitGapPageBatch');
  return await storeCall({ member: 'readGitGapPageBatch', sourceId }, () => brain.readGitGapPageBatch(sourceId,
    'ids' in batch ? null : batch.after, 'ids' in batch ? [...batch.ids] : null, honorAliases)) as GitGapPageRow[];
};

export const countGitGapFactsOnPages: StoreMember<[sourceId: string, slugs: readonly string[]], number> = async (brain, sourceId, slugs) =>
  Number(await storeCall({ member: 'countGitGapFactsOnPages', sourceId }, () => brain.countGitGapFactsOnPages(sourceId, [...slugs])));

export const countGitGapTimelineOnPages: StoreMember<[pageIds: readonly number[]], number> = async (brain, pageIds) =>
  Number(await storeCall({ member: 'countGitGapTimelineOnPages' }, () => brain.countGitGapTimelineOnPages([...pageIds])));

export const readGitGapSourceRows: StoreMember<[sourceId: string, derivedLinkSources: readonly string[], holdOp: string], GitGapSourceRows> = async (brain, sourceId, derived, holdOp) =>
  await storeCall({ member: 'readGitGapSourceRows', sourceId }, () => brain.readGitGapSourceRows(sourceId, [...derived], holdOp)) as GitGapSourceRows;
