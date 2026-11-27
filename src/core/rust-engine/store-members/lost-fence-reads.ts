/**
 * The reads of `gbrain repair lost-fence-rows` (src/core/engine-sql/lost-fence-reads.ts): the generation ledger's
 * retired fence items (generations/lost_fence.rs), the page's inline version texts (repair_versions.rs), and the fact and
 * take row checks (facts/text_repair.rs, takes/reads.rs). None applies a read policy, so none takes one.
 *
 * Export only BrainEngine members from this file, each a `StoreMember` named after the member it serves (see tags.ts):
 * index.ts spreads the whole module into STORE_MEMBERS, so every export is served. Helpers stay unexported.
 */
import type { BrainEngine } from '../../engine.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

function whole(member: string, what: string, ...values: number[]): void {
  if (values.some(v => !Number.isSafeInteger(v))) refuseMember(member, `${what} that is not an integer`);
}

const tierRow = (row: { id: number; trust_tier: string | null } | null) => row && { id: Number(row.id), trust_tier: row.trust_tier };

export const listRetiredFenceItems: Member<'listRetiredFenceItems'> = (brain, sourceIds, only) =>
  storeCall({ member: 'listRetiredFenceItems' }, () => brain.listRetiredFenceItems([...sourceIds], only?.source_id ?? null, only?.slug ?? null));

export const listInlineVersionTexts: Member<'listInlineVersionTexts'> = async (brain, pageId) => {
  whole('listInlineVersionTexts', 'a page id', pageId);
  const rows: Array<{ id: number; compiled_truth: string; timeline: string | null }> = await storeCall({ member: 'listInlineVersionTexts' }, () => brain.listInlineVersionTexts(pageId));
  return rows.map(row => ({ id: Number(row.id), compiled_truth: row.compiled_truth, timeline: row.timeline ?? null }));
};

export const hasActiveFactText: Member<'hasActiveFactText'> = (brain, sourceId, slug, fact, visibility) =>
  storeCall({ member: 'hasActiveFactText', slug, sourceId }, () => brain.hasActiveFactText({ sourceId, slug, fact, visibility }));

export const hasTakeClaim: Member<'hasTakeClaim'> = (brain, pageId, claim) => {
  whole('hasTakeClaim', 'a page id', pageId);
  return storeCall({ member: 'hasTakeClaim' }, () => brain.hasTakeClaim(pageId, claim));
};

export const readFactTrustTier: Member<'readFactTrustTier'> = (brain, id) => {
  whole('readFactTrustTier', 'a fact id', id);
  return storeCall({ member: 'readFactTrustTier' }, () => brain.readFactTrustTier(id));
};

export const listFenceFactRowNums: Member<'listFenceFactRowNums'> = async (brain, sourceId, slug) => {
  const rows: number[] = await storeCall({ member: 'listFenceFactRowNums', slug, sourceId }, () => brain.listFenceFactRowNums({ sourceId, slug, sources: [] }));
  return rows.map(Number);
};

export const listTakeRowNums: Member<'listTakeRowNums'> = async (brain, pageId) => {
  whole('listTakeRowNums', 'a page id', pageId);
  const rows: number[] = await storeCall({ member: 'listTakeRowNums' }, () => brain.listTakeRowNums(pageId));
  return rows.map(Number);
};

export const readLiveFactRowTier: Member<'readLiveFactRowTier'> = async (brain, sourceId, slug, rowNum, fact) => {
  whole('readLiveFactRowTier', 'a row number', rowNum);
  return tierRow(await storeCall({ member: 'readLiveFactRowTier', slug, sourceId }, () => brain.readLiveFactRowTier({ sourceId, slug, rowNum, fact })));
};

export const readTakeRowTierByClaim: Member<'readTakeRowTierByClaim'> = async (brain, pageId, rowNum, claim) => {
  whole('readTakeRowTierByClaim', 'a page id or row number', pageId, rowNum);
  return tierRow(await storeCall({ member: 'readTakeRowTierByClaim' }, () => brain.readTakeRowTierByClaim(pageId, rowNum, claim)));
};
