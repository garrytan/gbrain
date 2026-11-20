/**
 * The count and list reads of takes, salience and code edges (engine-sql/takes-reads.ts), served by the store
 * (rust/docs/store/takes-reads.md).
 *
 * `countMcpResolvedTakes` reads the caller's source and holder scope. Under `excludePrivate` the SQL adds the page
 * policy of the caller in context (`privatePagesFilterForCaller('p')`): `storePagePolicy` sends the flags the store
 * applies when the caller is the one the store models, and refuses with `engine_capability_missing` for a caller
 * whose member pages, grants or lineage widen the policy.
 */
import { checkTakePreimageRead, type HeldFenceTakeRow, type HeldFenceTakeSpec, type McpResolvedSpec, type PurgeTakesSpec, type TakePreimage, type TakePreimageRead } from '../../engine-sql/takes-reads.ts';
import { storeCall, type StoreMember } from './common.ts';
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

/**
 * The store keeps no fence generations (`derived_generations`), so no take_fence generation is ever held
 * `fence_absent`, and the answer is none, as PGLite gives for a page whose fence generation is not held.
 */
export const listHeldFenceTakeRows: StoreMember<[spec: HeldFenceTakeSpec], HeldFenceTakeRow[]> = async () => [];

/** The store reads the page's takes by row number and joins the incoming rows as the SQL does; the arguments are checked first. */
export const readTakePreimages: StoreMember<[read: TakePreimageRead], Array<{ preimage: TakePreimage; gone: boolean }>> = async (brain, read) => {
  checkTakePreimageRead(read);
  if (!read.gone.length && !read.incoming.length) return [];
  return storeCall({ member: 'readTakePreimages' }, () => brain.readTakePreimages({
    pageId: read.pageId, by: read.by, gone: [...read.gone], incoming: read.incoming.map(take => ({ ...take })),
  }));
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

export const countZeroWeightWithTakes: StoreMember<[], { zero_weight_with_takes: number; nonzero_weight: number }> = (brain) =>
  storeCall({ member: 'countZeroWeightWithTakes' }, () => brain.countZeroWeightWithTakes());

export const hasCodeEdgesSymbol: StoreMember<[sourceId: string], boolean> = (brain, sourceId) =>
  storeCall({ member: 'hasCodeEdgesSymbol' }, () => brain.hasCodeEdgesSymbol(sourceId));
