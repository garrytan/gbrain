/**
 * A page publication's fence projection and fence guard statements (engine-sql/fence-projection.ts,
 * engine-sql/trust-fence.ts), a tier-only row change (engine-sql/row-tier.ts) and the unwithdrawn-facts repair's page
 * body read (engine-sql/unwithdrawn-restore.ts), served from the store's fact, take, generation,
 * alias and page records (rust/crates/gbrain-store/src/facts/fence_projection.rs, takes/fence_projection.rs,
 * trust/row_tier.rs, facts/unwithdrawn_restore.rs). The writes join the engine's transaction when one is bound; the
 * writer's tier and the opened fact ids come from the store's write trust context, which the transaction sets in place
 * of `gbrain.write_trust_tier` and `gbrain.write_open_facts`. None applies a caller read policy, as the statements never
 * did. rust/docs/store/facts.md, "The fence projection's statements".
 *
 * Export only BrainEngine members from this file, each a `StoreMember` named after the member it serves (see tags.ts):
 * index.ts spreads the whole module into STORE_MEMBERS, so every export is served. Helpers stay unexported.
 */
import type { BrainEngine } from '../../engine.ts';
import { storeCall, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

const nums = (rows: unknown[]) => rows.map(Number);
const tierRow = (row: { id: number; trust_tier: string } | null) => row && { id: Number(row.id), trust_tier: row.trust_tier };

export const listQuotedTakeRows: Member<'listQuotedTakeRows'> = async (brain, pageId, rowNums) => {
  const rows: Array<{ row_num: number; claim: string }> = await storeCall({ member: 'listQuotedTakeRows' }, () => brain.listQuotedTakeRows(pageId, [...rowNums]));
  return rows.map(r => ({ row_num: Number(r.row_num), claim: r.claim }));
};

export const listPageFenceFactCells: Member<'listPageFenceFactCells'> = async (brain, sourceId, slug) => {
  const rows: Array<{ row_num: number; fact: string; visibility: string }> = await storeCall({ member: 'listPageFenceFactCells', slug, sourceId },
    () => brain.listPageFenceFactCells(sourceId, slug));
  return rows.map(r => ({ row_num: Number(r.row_num), fact: r.fact, visibility: r.visibility }));
};

export const hasPositionedPageFacts: Member<'hasPositionedPageFacts'> = (brain, sourceId, slug) =>
  storeCall({ member: 'hasPositionedPageFacts', slug, sourceId }, () => brain.hasPositionedPageFacts(sourceId, slug));

export const hasFenceAbsentHold: Member<'hasFenceAbsentHold'> = (brain, sourceId, kind, ownerKey) =>
  storeCall({ member: 'hasFenceAbsentHold', sourceId }, () => brain.hasFenceAbsentHold({ sourceId, kind, ownerKey }));

export const listPageTakeRowNums: Member<'listPageTakeRowNums'> = async (brain, pageId) =>
  nums(await storeCall({ member: 'listPageTakeRowNums' }, () => brain.listPageTakeRowNums(pageId)));

export const expireFenceFacts: Member<'expireFenceFacts'> = async (brain, sourceId, slug, incoming, ids) => {
  await storeCall({ member: 'expireFenceFacts', slug, sourceId }, () => brain.expireFenceFacts(sourceId, slug, incoming, [...ids]));
};

export const refreshFenceFactFields: Member<'refreshFenceFactFields'> = async (brain, sourceId, slug, fieldRows) => {
  await storeCall({ member: 'refreshFenceFactFields', slug, sourceId }, () => brain.refreshFenceFactFields(sourceId, slug, fieldRows));
};

export const clearChangedTakeResolutions: Member<'clearChangedTakeResolutions'> = async (brain, pageId, claims) => {
  await storeCall({ member: 'clearChangedTakeResolutions' }, () => brain.clearChangedTakeResolutions(pageId, claims));
};

export const writeFenceTakeResolutions: Member<'writeFenceTakeResolutions'> = async (brain, pageId, resolutions) => {
  await storeCall({ member: 'writeFenceTakeResolutions' }, () => brain.writeFenceTakeResolutions(pageId, resolutions));
};

export const detachFenceFactRows: Member<'detachFenceFactRows'> = async (brain, ids) => {
  await storeCall({ member: 'detachFenceFactRows' }, () => brain.detachFenceFactRows([...ids]));
};

export const listOccupiedFenceRowNums: Member<'listOccupiedFenceRowNums'> = async (brain, sourceId, slug) =>
  nums(await storeCall({ member: 'listOccupiedFenceRowNums', slug, sourceId }, () => brain.listOccupiedFenceRowNums(sourceId, slug)));

export const moveGuardedFenceRows: Member<'moveGuardedFenceRows'> = async (brain, moves) => {
  await storeCall({ member: 'moveGuardedFenceRows' }, () => brain.moveGuardedFenceRows(JSON.stringify(moves)));
};

export const listTrustedPrivateCopies: Member<'listTrustedPrivateCopies'> = async (brain, sourceId, slug, restated) => {
  const rows: Array<{ row_num: number; id: number; visibility: string; trust_tier: string }> = await storeCall({ member: 'listTrustedPrivateCopies', slug, sourceId },
    () => brain.listTrustedPrivateCopies(sourceId, slug, JSON.stringify(restated.map(r => ({ row_num: r.row_num, fact: r.fact, entity: r.entity ?? null })))));
  return rows.map(r => ({ row_num: Number(r.row_num), id: Number(r.id), visibility: r.visibility, trust_tier: r.trust_tier }));
};

export const readLiveFenceFactAt: Member<'readLiveFenceFactAt'> = async (brain, sourceId, slug, rowNum) =>
  tierRow(await storeCall({ member: 'readLiveFenceFactAt', slug, sourceId }, () => brain.readLiveFenceFactAt(sourceId, slug, rowNum)));

export const listFactsAboveWriter: Member<'listFactsAboveWriter'> = async (brain, sourceId, slug) => {
  const rows: Array<{ id: number; trust_tier: string }> = await storeCall({ member: 'listFactsAboveWriter', slug, sourceId }, () => brain.listFactsAboveWriter(sourceId, slug));
  return rows.map(r => ({ id: Number(r.id), trust_tier: r.trust_tier }));
};

export const readRowTrustTier: Member<'readRowTrustTier'> = (brain, table, id) =>
  storeCall({ member: 'readRowTrustTier' }, () => brain.readRowTrustTier(table, id));

export const setRowTrustTier: Member<'setRowTrustTier'> = async (brain, table, id, tier, decision) =>
  nums(await storeCall({ member: 'setRowTrustTier' }, () => brain.setRowTrustTier(table, id, tier, decision)));

export const readTierProjectionPage: Member<'readTierProjectionPage'> = (brain, table, id) =>
  storeCall({ member: 'readTierProjectionPage' }, () => brain.readTierProjectionPage(table, id));

export const readPageInlineBody: Member<'readPageInlineBody'> = async (brain, pageId) => {
  const row: { id: number; compiled_truth: string | null; timeline: string | null; body_storage: string | null } | null =
    await storeCall({ member: 'readPageInlineBody' }, () => brain.readPageInlineBody(Number(pageId)));
  return row && { id: Number(row.id), compiled_truth: row.compiled_truth ?? null, timeline: row.timeline ?? null, body_storage: row.body_storage ?? null };
};
