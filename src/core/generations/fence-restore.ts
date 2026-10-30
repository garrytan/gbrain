/**
 * GBRA-161 PR 2 (plan D6): a fence kind restores by transplanting the fence block the earlier generation recorded into
 * the page as it is now, through an ordinary guarded `put_page` of the page's current content bound to its current
 * revision (`edit_page` refuses to write fence markers). Only the fence block changes: the body around it, the timeline, the tags and the other fence are left as they are, and the page
 * projection then re-derives the rows (a new generation). A page whose fence was edited since the live generation (or
 * removed, or moved to another section) is refused whole (`edited_since`, `section_moved`); a generation whose block
 * was too large to keep restores nothing (`no_preimage`).
 */
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { OperationError, type OperationContext } from '../ops/contract.ts';
import { serializePageToMarkdown } from '../markdown.ts';
import { submitPageMutation } from '../persistence/page-mutations.ts';
import { fenceName, fenceSlugOf, readFenceBlocks, type FenceBlocks, type FenceGenerationKind } from './fence.ts';
import type { GenerationKey } from './contract.ts';

export interface FenceRestorePlan { revive: string[]; retire: string[]; refused: string[]; content: string | null; revision: string | null }

/** What transplanting generation `prevId`'s fence block over the live generation `liveId`'s would do, read now. */
export async function planFenceRestore(db: BrainEngine, key: GenerationKey, liveId: number, prevId: number): Promise<FenceRestorePlan> {
  const generations = await db.executeRaw<{ id: number; fence: FenceBlocks | null }>(
    `SELECT id, completeness->'fence' AS fence FROM derived_generations WHERE id = ANY($1::bigint[])`, [[liveId, prevId]]);
  const blocks = new Map(generations.map(row => [Number(row.id), row.fence && typeof row.fence === 'object' ? row.fence : null]));
  const items = await db.executeRaw<{ generation_id: number; item_key: string }>(
    `SELECT generation_id, item_key FROM derived_generation_items WHERE generation_id = ANY($1::bigint[]) AND action <> 'retired'`, [[liveId, prevId]]);
  const owned = (id: number) => new Set(items.filter(item => Number(item.generation_id) === id).map(item => item.item_key));
  const [target, current] = [owned(prevId), owned(liveId)];
  const revive = [...target].filter(itemKey => !current.has(itemKey)).sort();
  const retire = [...current].filter(itemKey => !target.has(itemKey)).sort();
  const refuse = (reason: string): FenceRestorePlan => ({ revive, retire, refused: [`${key.ownerKey}: ${reason}`], content: null, revision: null });
  const want = blocks.get(prevId); const recorded = blocks.get(liveId);
  if (!want || !recorded) return refuse('no_preimage');
  const slug = fenceSlugOf(key.ownerKey);
  const snapshot = slug ? await db.readPageSnapshot(slug, { sourceId: key.sourceId }) : null;
  if (!snapshot || snapshot.page.deleted_at) return refuse('page_gone');
  if (snapshot.page.body_storage === 'segmented') return refuse('segmented_unsupported');
  const read = readFenceBlocks(snapshot.page, fenceName(key.kind as FenceGenerationKind));
  if (read.state !== 'parsed' || read.blocks.body !== recorded.body || read.blocks.timeline !== recorded.timeline) return refuse('edited_since');
  let content = serializePageToMarkdown(snapshot.page, await db.getTags(slug!, { sourceId: key.sourceId }));
  for (const section of ['body', 'timeline'] as const) {
    const [now, then] = [read.blocks[section], want[section]];
    if (now === then) continue;
    if (now === null) return refuse('section_moved');
    const at = content.indexOf(now);
    if (at === -1 || content.indexOf(now, at + 1) !== -1) return refuse('block_ambiguous');
    content = content.slice(0, at) + (then ?? '') + content.slice(at + now.length);
  }
  return { revive, retire, refused: [], content, revision: snapshot.revision };
}

/** Applies an approved fence restore: re-plans under the page's current revision and writes the page with only its fence block changed. */
export async function applyFenceRestore(ctx: OperationContext, key: GenerationKey, approved: { id: number; restore_to_id: number; revive: string[]; retire: string[]; refused: string[] }):
  Promise<'changed' | string[] | { written: boolean }> {
  const [live] = await ctx.engine.executeRaw<{ id: number }>(`SELECT id FROM derived_generations WHERE source_id=$1 AND kind=$2 AND owner_key=$3 AND state='live'`,
    [key.sourceId, key.kind, key.ownerKey]);
  if (Number(live?.id) !== approved.id) return 'changed';
  const plan = await planFenceRestore(ctx.engine, key, approved.id, approved.restore_to_id);
  if (JSON.stringify([plan.revive, plan.retire, plan.refused]) !== JSON.stringify([approved.revive, approved.retire, approved.refused])) return 'changed';
  if (plan.refused.length) return plan.refused;
  try {
    await submitPageMutation(ctx, { operation: 'put_page', params: { slug: fenceSlugOf(key.ownerKey)!, source_id: key.sourceId, expected_revision: plan.revision!,
      content: plan.content!, request_id: randomUUID() } });
  } catch (error) {
    if (error instanceof OperationError && error.code === 'revision_conflict') return 'changed';
    throw error;
  }
  return { written: true };
}
