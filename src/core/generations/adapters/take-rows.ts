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
import { fenceRowKey, publishFenceGeneration, takeRowIdentity, TAKE_FENCE_KIND, type FenceGenerationOutcome, type FenceItem, type FenceRead } from '../fence.ts';

/** The columns a take's before-state keeps (every column but its vector and write attribution). */
const TAKE_PREIMAGE_SQL = `jsonb_build_object('id', k.id, 'page_id', k.page_id, 'row_num', k.row_num, 'claim', k.claim, 'kind', k.kind, 'holder', k.holder,
  'weight', k.weight, 'since_date', k.since_date, 'until_date', k.until_date, 'source', k.source, 'superseded_by', k.superseded_by, 'active', k.active,
  'resolved_at', k.resolved_at, 'resolved_outcome', k.resolved_outcome, 'resolved_value', k.resolved_value, 'resolved_unit', k.resolved_unit,
  'resolved_source', k.resolved_source, 'resolved_by', k.resolved_by, 'resolved_quality', k.resolved_quality)`;

type TakePreimage = { id: number; row_num: number; claim: string; kind: string; holder: string };
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
  const incoming = JSON.stringify(replaced.map(take => ({ row_num: take.rowNum, claim: take.claim, kind: take.kind, holder: take.holder })));
  const rows = await db.executeRaw<{ preimage: TakePreimage; gone: boolean }>(
    `SELECT ${TAKE_PREIMAGE_SQL} AS preimage, k.id = ANY($2::bigint[]) AS gone FROM takes k
      LEFT JOIN jsonb_to_recordset($3::text::jsonb) AS n(row_num integer, claim text, kind text, holder text) ON n.row_num = k.row_num
     WHERE k.page_id = $1 AND (k.id = ANY($2::bigint[]) OR (n.row_num IS NOT NULL AND (k.claim, k.kind, k.holder) IS DISTINCT FROM (n.claim, n.kind, n.holder)))
     ORDER BY k.row_num`, [pageId, [...ids], incoming]);
  return { gone: rows.filter(row => row.gone).map(row => row.preimage), replaced: rows.filter(row => !row.gone).map(row => row.preimage) };
}

/**
 * Before a takes write: the stored takes it would delete (`gone` row numbers) and those it would replace (same number,
 * different claim, kind or holder), each with its full row. Held: the caller deletes and overwrites nothing.
 */
export async function projectTakeFenceGeneration(tx: BrainEngine, input: { sourceId: string; slug: string; pageId: number; read: FenceRead;
  takes: readonly IncomingTake[]; gone: readonly number[]; writer: string; runId?: string }): Promise<FenceGenerationOutcome> {
  const incoming = JSON.stringify(input.takes.map(take => ({ row_num: take.rowNum, claim: take.claim, kind: take.kind, holder: take.holder })));
  const rows = (input.gone.length || input.takes.length) ? await tx.executeRaw<{ preimage: TakePreimage; gone: boolean }>(
    `SELECT ${TAKE_PREIMAGE_SQL} AS preimage, k.row_num = ANY($2::integer[]) AS gone FROM takes k
      LEFT JOIN jsonb_to_recordset($3::text::jsonb) AS n(row_num integer, claim text, kind text, holder text) ON n.row_num = k.row_num
     WHERE k.page_id = $1 AND (k.row_num = ANY($2::integer[]) OR (n.row_num IS NOT NULL AND (k.claim, k.kind, k.holder) IS DISTINCT FROM (n.claim, n.kind, n.holder)))
     ORDER BY k.row_num`, [input.pageId, [...input.gone], incoming]) : [];
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
