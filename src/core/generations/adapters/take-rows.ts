/**
 * GBRA-161 PR 2: the take-rows adapter (`take_fence`, one owner key per page). A page's takes fence is the system of
 * record for its takes (fence.ts). The page publication's projection and `gbrain extract takes` delete the takes whose row
 * left a fence that was read whole, and overwrite a take whose claim, kind or holder changed at its row number (the
 * `addTakesBatch` upsert, B-19). Both now ask `publishFenceGeneration` first: an absent fence holds (`fence_absent`) and
 * deletes nothing, and every deleted or replaced take's full row (database-only resolution included) is recorded on the
 * ledger before it changes.
 */
import type { BrainEngine } from '../../engine.ts';
import type { GenerationAdapter } from '../contract.ts';
import type { TakePreimage } from '../../engine-sql/takes-reads.ts';
import { fenceRowKey, publishFenceGeneration, takeRowIdentity, TAKE_FENCE_KIND, type FenceGenerationOutcome, type FenceItem, type FenceRead } from '../fence.ts';

type IncomingTake = { rowNum: number; claim: string; kind: string; holder: string };

export function takeFenceItems(takes: readonly IncomingTake[]): FenceItem[] {
  return takes.map(take => {
    const identityHash = takeRowIdentity({ row_num: take.rowNum, claim: take.claim, kind: take.kind, holder: take.holder });
    return { key: fenceRowKey(take.rowNum, identityHash), identityHash };
  });
}

export const takeItem = (preimage: TakePreimage, key = `take:${preimage.id}`): FenceItem => ({ key, preimage: preimage as unknown as Record<string, unknown>,
  identityHash: takeRowIdentity({ row_num: Number(preimage.row_num), claim: preimage.claim, kind: preimage.kind, holder: preimage.holder }) });

/** Full rows of the takes `ids` of page `pageId` (before-states), and of the takes `replaced` would overwrite at their numbers. */
export async function takePreimages(db: BrainEngine, pageId: number, ids: readonly number[], replaced: readonly IncomingTake[] = []): Promise<{ gone: TakePreimage[]; replaced: TakePreimage[] }> {
  if (!ids.length && !replaced.length) return { gone: [], replaced: [] };
  const rows = await db.readTakePreimages({ pageId, by: 'id', gone: ids,
    incoming: replaced.map(take => ({ row_num: take.rowNum, claim: take.claim, kind: take.kind, holder: take.holder })) });
  return { gone: rows.filter(row => row.gone).map(row => row.preimage), replaced: rows.filter(row => !row.gone).map(row => row.preimage) };
}

/**
 * Before a takes write: the stored takes it would delete (`gone` row numbers) and those it would replace (same number,
 * different claim, kind or holder), each with its full row. Held: the caller deletes and overwrites nothing.
 */
export async function projectTakeFenceGeneration(tx: BrainEngine, input: { sourceId: string; slug: string; pageId: number; read: FenceRead;
  takes: readonly IncomingTake[]; gone: readonly number[]; writer: string; runId?: string }): Promise<FenceGenerationOutcome> {
  const rows = (input.gone.length || input.takes.length) ? await tx.readTakePreimages({ pageId: input.pageId, by: 'row_num', gone: input.gone,
    incoming: input.takes.map(take => ({ row_num: take.rowNum, claim: take.claim, kind: take.kind, holder: take.holder })) }) : [];
  const items = takeFenceItems(input.takes);
  const byRow = new Map(input.takes.map((take, index) => [take.rowNum, items[index]!.key]));
  return publishFenceGeneration(tx, { kind: TAKE_FENCE_KIND, sourceId: input.sourceId, slug: input.slug, read: input.read, items, writer: input.writer, runId: input.runId,
    retire: rows.filter(row => row.gone).map(row => takeItem(row.preimage)),
    overwrite: rows.filter(row => !row.gone).map(row => takeItem(row.preimage, byRow.get(Number(row.preimage.row_num)))) });
}

/** The take_fence adapter as the repair command resolves it: fence kinds restore by transplanting the fence (repair.ts). */
export const takeFenceAdapter: GenerationAdapter<undefined> = {
  kind: TAKE_FENCE_KIND,
  retiredBy: 'generation-restore',
  modelProduced: false,
  fence: 'takes',
  lockKeys: (key) => [{ sourceId: key.sourceId, slug: key.ownerKey.replace(/^page:/, '') }],
  readInput: async () => null,
  readItems: async () => new Map(),
  legacyEvidence: async () => new Set(),
  publishItems: async () => { throw new Error('take_fence rows publish through the page fence (publishFenceGeneration)'); },
  retireItems: async () => { throw new Error('take_fence rows retire through the page fence (publishFenceGeneration)'); },
  restoreItem: async () => { throw new Error('take_fence rows restore through the fence block (repair generations)'); },
  preimageIdentity: preimage => takeRowIdentity(preimage as unknown as { row_num: number; claim: string; kind: string; holder: string }),
};
