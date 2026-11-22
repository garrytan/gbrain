/**
 * The count and list reads of takes, salience and code edges (engine-sql/takes-reads.ts), served by the store
 * (rust/docs/store/takes-reads.md).
 *
 * `countMcpResolvedTakes` reads the caller's source and holder scope. Under `excludePrivate` the SQL adds the page
 * policy of the caller in context (`privatePagesFilterForCaller('p')`): `storePagePolicy` sends the flags the store
 * applies when the caller is the one the store models, and refuses with `engine_capability_missing` for a caller
 * whose member pages, grants or lineage widen the policy.
 *
 * The reads and the delete of `gbrain extract takes` (readLivePageIdBySlug through findTakeId) refuse a page, take or
 * row id that is not an integer, as the SQL's integer casts refuse it.
 */
import { checkTakePreimageRead, type HeldFenceTakeRow, type HeldFenceTakeSpec, type McpResolvedSpec, type PageTierRef, type PurgeTakesSpec, type TakePreimage, type TakePreimageRead, type TakesLeavingFence, type AcceptedTakeRemoval } from '../../engine-sql/takes-reads.ts';
import { storedTrustTier } from '../../trust/tier.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';
import { storePagePolicy } from './private-provenance.ts';

export const countOffGridTakeWeights: StoreMember<[], { off_grid: number; total: number }> = (brain) =>
  storeCall({ member: 'countOffGridTakeWeights' }, () => brain.countOffGridTakeWeights());

export const countTakes: StoreMember<[], number> = (brain) =>
  storeCall({ member: 'countTakes' }, () => brain.countTakes());

export const planFactPurgeTakes: StoreMember<[spec: PurgeTakesSpec], Array<{ id: number; page_id: number }>> = (brain, spec) =>
  storeCall({ member: 'planFactPurgeTakes' }, () => brain.planFactPurgeTakes({
    sourceId: spec.sourceId, factIds: [...spec.factIds], factHash: spec.factHash, subject: spec.subject,
  }));

export const listTakeRowsForPage: StoreMember<[pageId: number], Array<{ row_num: number; claim: string }>> = (brain, pageId) =>
  storeCall({ member: 'listTakeRowsForPage' }, () => brain.listTakeRowsForPage(pageId));

/** The store reads the page's takes by row number and joins the incoming rows as the SQL does; the arguments are checked first. */
export const readTakePreimages: StoreMember<[read: TakePreimageRead], Array<{ preimage: TakePreimage; gone: boolean }>> = async (brain, read) => {
  checkTakePreimageRead(read);
  if (!read.gone.length && !read.incoming.length) return [];
  return storeCall({ member: 'readTakePreimages' }, () => brain.readTakePreimages({
    pageId: read.pageId, by: read.by, gone: [...read.gone], incoming: read.incoming.map(take => ({ ...take })),
  }));
};

/**
 * The page's takes by row number while its take_fence generation is held `fence_absent` in the store's generation
 * ledger (`derived_generations`), none otherwise. `resolved_at` comes back as a Date, as the SQL engines read it.
 */
export const listHeldFenceTakeRows: StoreMember<[spec: HeldFenceTakeSpec], HeldFenceTakeRow[]> = async (brain, spec) => {
  const rows = await storeCall<HeldFenceTakeRow[]>({ member: 'listHeldFenceTakeRows', sourceId: spec.sourceId }, () => brain.listHeldFenceTakeRows({
    sourceId: spec.sourceId, kind: spec.kind, ownerKey: spec.ownerKey, pageId: spec.pageId }));
  return rows.map(row => ({ ...row, resolved_at: row.resolved_at == null ? null : new Date(row.resolved_at) }));
};

export const countMcpResolvedTakes: StoreMember<[spec: McpResolvedSpec], number> = (brain, spec) => {
  const excludePrivate = storePagePolicy('countMcpResolvedTakes', spec.excludePrivate, { callerReaders: true });
  return storeCall({ member: 'countMcpResolvedTakes' }, () => brain.countMcpResolvedTakes({
    sourceIds: spec.sourceIds ? [...spec.sourceIds] : null,
    holders: spec.holders ? [...spec.holders] : null,
    excludePrivate: excludePrivate ?? null,
  }));
};

export const listTakeSupersessionCandidates: StoreMember<[sourceIds: readonly string[]], Array<{ id: number; source_id: string; slug: string }>> =
  (brain, sourceIds) => storeCall({ member: 'listTakeSupersessionCandidates' }, () => brain.listTakeSupersessionCandidates([...sourceIds]));

export const listTakePointers: StoreMember<[pageId: number], Array<{ row_num: number; superseded_by: number | null }>> = (brain, pageId) => {
  if (!Number.isSafeInteger(pageId)) refuseMember('listTakePointers', 'a page id that is not an integer');
  return storeCall({ member: 'listTakePointers' }, () => brain.listTakePointers(pageId));
};

export const listTakeSupersedeReceipts: StoreMember<[sourceId: string, pageId: number, slug: string], Array<{ old_row: string | null; new_row: string | null }>> =
  (brain, sourceId, pageId, slug) => {
    if (!Number.isSafeInteger(pageId)) refuseMember('listTakeSupersedeReceipts', 'a page id that is not an integer');
    return storeCall({ member: 'listTakeSupersedeReceipts' }, () => brain.listTakeSupersedeReceipts(sourceId, pageId, slug));
  };

export const setTakeSupersededBy: StoreMember<[pageId: number, rowNum: number, supersededBy: number | null], void> = (brain, pageId, rowNum, supersededBy) => {
  if (!Number.isSafeInteger(pageId) || !Number.isSafeInteger(rowNum) || (supersededBy !== null && !Number.isSafeInteger(supersededBy))) {
    refuseMember('setTakeSupersededBy', 'a page id or row number that is not an integer');
  }
  return storeCall({ member: 'setTakeSupersededBy' }, () => brain.setTakeSupersededBy(pageId, rowNum, supersededBy));
};

/** The accepted take removals of the sources, by proposal id (trust/proposals.rs, read with the journal's committed requests). */
export const listAcceptedTakeRemovals: StoreMember<[sourceIds: readonly string[], proposalId: number | null], AcceptedTakeRemoval[]> = (brain, sourceIds, proposalId) => {
  if (proposalId !== null && !Number.isSafeInteger(proposalId)) refuseMember('listAcceptedTakeRemovals', 'a proposal id that is not an integer');
  return storeCall({ member: 'listAcceptedTakeRemovals' }, () => brain.listAcceptedTakeRemovals({ sourceIds: [...sourceIds], proposalId }));
};

export const readTakeRowTier: StoreMember<[pageId: number, rowNum: number], { id: number; trust_tier: string } | null> = (brain, pageId, rowNum) => {
  if (!Number.isSafeInteger(pageId) || !Number.isSafeInteger(rowNum)) refuseMember('readTakeRowTier', 'a page id or row number that is not an integer');
  return storeCall({ member: 'readTakeRowTier' }, () => brain.readTakeRowTier(pageId, rowNum));
};

export const countZeroWeightWithTakes: StoreMember<[], { zero_weight_with_takes: number; nonzero_weight: number }> = (brain) =>
  storeCall({ member: 'countZeroWeightWithTakes' }, () => brain.countZeroWeightWithTakes());

export const hasCodeEdgesSymbol: StoreMember<[sourceId: string], boolean> = (brain, sourceId) =>
  storeCall({ member: 'hasCodeEdgesSymbol' }, () => brain.hasCodeEdgesSymbol(sourceId));

// ---- The reads and the delete of `gbrain extract takes` ----

function ints(member: string, values: readonly number[]): number[] {
  if (!values.every(Number.isSafeInteger)) refuseMember(member, 'an id or row number that is not an integer');
  return [...values];
}

export const readLivePageIdBySlug: StoreMember<[slug: string, sourceId: string], number | null> = async (brain, slug, sourceId) => {
  const id = await storeCall({ member: 'readLivePageIdBySlug', slug, sourceId }, () => brain.readLivePageIdBySlug(slug, sourceId)) as number | null;
  return id === null || id === undefined ? null : Number(id);
};

export const readPageTierRef: StoreMember<[pageId: number], PageTierRef | null> = async (brain, pageId) => {
  ints('readPageTierRef', [pageId]);
  const page = await storeCall({ member: 'readPageTierRef' }, () => brain.readPageTierRef(pageId)) as { source_id: string; slug: string; trust_tier: string } | null;
  return page ? { source_id: page.source_id, slug: page.slug, trust_tier: storedTrustTier(page.trust_tier) } : null;
};

export const readPageTierRows: StoreMember<[ids: readonly number[]], Array<PageTierRef & { id: number }>> = async (brain, ids) => {
  const wanted = ints('readPageTierRows', ids);
  const rows = await storeCall({ member: 'readPageTierRows' }, () => brain.readPageTierRows(wanted)) as Array<{ id: number; source_id: string; slug: string; trust_tier: string }>;
  return rows.map(r => ({ id: Number(r.id), source_id: r.source_id, slug: r.slug, trust_tier: storedTrustTier(r.trust_tier) }));
};

export const pageHasFrontmatterKey: StoreMember<[pageId: number, key: string], boolean> = async (brain, pageId, key) => {
  ints('pageHasFrontmatterKey', [pageId]);
  return (await storeCall({ member: 'pageHasFrontmatterKey' }, () => brain.pageHasFrontmatterKey(pageId, key))) === true;
};

export const listTakeIdsLeavingFence: StoreMember<[pageId: number, fence: TakesLeavingFence], number[]> = async (brain, pageId, fence) => {
  const member = 'listTakeIdsLeavingFence';
  ints(member, [pageId]);
  const arg = fence.change === 'removed'
    ? { change: 'removed', rowNums: ints(member, fence.rowNums) }
    : { change: 'replaced', rows: fence.rows.map(r => ({ row_num: ints(member, [r.row_num])[0], claim: r.claim })) };
  const ids = await storeCall({ member }, () => brain.listTakeIdsLeavingFence(pageId, arg)) as number[];
  return ids.map(Number);
};

export const listTakePreimages: StoreMember<[pageId: number, ids: readonly number[], incoming: ReadonlyArray<{ row_num: number; claim: string; kind: string; holder: string }>], Array<{ preimage: TakePreimage; gone: boolean }>> =
  async (brain, pageId, ids, incoming) => {
    const member = 'listTakePreimages';
    ints(member, [pageId, ...incoming.map(t => t.row_num)]);
    const rows = await storeCall({ member }, () => brain.listTakePreimages(pageId, ints(member, ids),
      incoming.map(t => ({ row_num: t.row_num, claim: t.claim, kind: t.kind, holder: t.holder })))) as Array<{ preimage: TakePreimage; gone: boolean }>;
    return rows.map(r => ({ preimage: r.preimage, gone: r.gone === true }));
  };

export const deleteTakesByIds: StoreMember<[ids: readonly number[]], void> = async (brain, ids) => {
  const wanted = ints('deleteTakesByIds', ids);
  if (!wanted.length) return;
  await storeCall({ member: 'deleteTakesByIds' }, () => brain.deleteTakesByIds(wanted));
};

export const findTakeId: StoreMember<[pageId: number, rowNum: number], number | null> = async (brain, pageId, rowNum) => {
  ints('findTakeId', [pageId, rowNum]);
  const id = await storeCall({ member: 'findTakeId' }, () => brain.findTakeId(pageId, rowNum)) as number | null;
  return id === null || id === undefined ? null : Number(id);
};
