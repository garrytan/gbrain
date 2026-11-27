/**
 * The reads of `gbrain repair lost-fence-rows` (src/core/repair/lost-fence-rows.ts): the retired fence items of the
 * generation ledger, a page's inline version texts, and the fact and take row checks of the scan, the planner and the
 * tier lowering. Both SQL engines delegate here; the Rust store serves the same members
 * (rust/crates/gbrain-store/src/generations/lost_fence.rs, facts/text_repair.rs, takes/reads.rs, repair_versions.rs).
 */
import type { BrainEngine } from '../engine.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

/** One retired fence item with its preimage, of a page's unproven, unheld fact or take fence generation. */
export interface RetiredFenceItem { kind: 'fact_fence' | 'take_fence'; source_id: string; slug: string; retired_at: string; preimage: Record<string, unknown> }

/** The retired fence items of these sources (or of one page), by (source, owner key, generation, item key). */
export async function listRetiredFenceItems(raw: Raw, sourceIds: readonly string[], only: { source_id: string; slug: string } | null): Promise<RetiredFenceItem[]> {
  return raw.executeRaw<RetiredFenceItem>(`SELECT g.kind, g.source_id, substr(g.owner_key, 6) AS slug, g.created_at::text AS retired_at, i.preimage
      FROM derived_generation_items i JOIN derived_generations g ON g.id = i.generation_id
     WHERE g.source_id = ANY($1::text[]) AND g.kind IN ('fact_fence','take_fence') AND g.state <> 'held' AND left(g.owner_key, 5) = 'page:'
       AND i.action = 'retired' AND i.preimage IS NOT NULL AND COALESCE(g.completeness->>'proof', '') = ''
       AND ($2::text IS NULL OR (g.source_id = $2 AND g.owner_key = 'page:' || $3))
     ORDER BY g.source_id, g.owner_key, g.id, i.item_key`, [[...sourceIds], only?.source_id ?? null, only?.slug ?? null]);
}

/** The page's versions with an inline body: id, body and timeline, by id. */
export async function listInlineVersionTexts(raw: Raw, pageId: number): Promise<Array<{ id: number; compiled_truth: string; timeline: string | null }>> {
  const rows = await raw.executeRaw<{ id: number; compiled_truth: string; timeline: string | null }>(`SELECT id::int AS id, compiled_truth, timeline
    FROM page_versions WHERE page_id=$1 AND compiled_truth IS NOT NULL ORDER BY id`, [pageId]);
  return rows.map(row => ({ ...row, id: Number(row.id) }));
}

/** Whether the page holds an unexpired fact with this text and visibility. */
export async function hasActiveFactText(raw: Raw, sourceId: string, slug: string, fact: string, visibility: string): Promise<boolean> {
  return (await raw.executeRaw(`SELECT 1 FROM facts WHERE source_id=$1 AND source_markdown_slug=$2 AND expired_at IS NULL AND fact=$3 AND visibility=$4`,
    [sourceId, slug, fact, visibility])).length > 0;
}

/** Whether page `pageId` holds a take with this claim. */
export async function hasTakeClaim(raw: Raw, pageId: number, claim: string): Promise<boolean> {
  return (await raw.executeRaw('SELECT 1 FROM takes WHERE page_id=$1 AND claim=$2', [pageId, claim])).length > 0;
}

/** The stored trust tier of fact `id`, or null when no fact has the id. */
export async function readFactTrustTier(raw: Raw, id: number): Promise<string | null> {
  const [row] = await raw.executeRaw<{ trust_tier: string | null }>('SELECT trust_tier FROM facts WHERE id=$1', [id]);
  return row?.trust_tier ?? null;
}

/** The row number of every fact (expired or not) the page holds. */
export async function listFenceFactRowNums(raw: Raw, sourceId: string, slug: string): Promise<number[]> {
  const rows = await raw.executeRaw<{ n: number }>('SELECT row_num AS n FROM facts WHERE source_id=$1 AND source_markdown_slug=$2 AND row_num IS NOT NULL', [sourceId, slug]);
  return rows.map(r => Number(r.n)).sort((a, b) => a - b);
}

/** The row number of every take of page `pageId`. */
export async function listTakeRowNums(raw: Raw, pageId: number): Promise<number[]> {
  const rows = await raw.executeRaw<{ n: number }>('SELECT row_num AS n FROM takes WHERE page_id=$1', [pageId]);
  return rows.map(r => Number(r.n)).sort((a, b) => a - b);
}

/** The id and tier of the page's unexpired fact at `rowNum` with this text, or null. */
export async function readLiveFactRowTier(raw: Raw, sourceId: string, slug: string, rowNum: number, fact: string): Promise<{ id: number; trust_tier: string | null } | null> {
  const [row] = await raw.executeRaw<{ id: number; trust_tier: string | null }>(`SELECT id::int AS id, trust_tier FROM facts
    WHERE source_id=$1 AND source_markdown_slug=$2 AND row_num=$3 AND fact=$4 AND expired_at IS NULL ORDER BY id LIMIT 1`, [sourceId, slug, rowNum, fact]);
  return row ? { id: Number(row.id), trust_tier: row.trust_tier } : null;
}

/** The id and tier of the take at `rowNum` of page `pageId` with this claim, or null. */
export async function readTakeRowTierByClaim(raw: Raw, pageId: number, rowNum: number, claim: string): Promise<{ id: number; trust_tier: string | null } | null> {
  const [row] = await raw.executeRaw<{ id: number; trust_tier: string | null }>('SELECT id::int AS id, trust_tier FROM takes WHERE page_id=$1 AND row_num=$2 AND claim=$3',
    [pageId, rowNum, claim]);
  return row ? { id: Number(row.id), trust_tier: row.trust_tier } : null;
}
