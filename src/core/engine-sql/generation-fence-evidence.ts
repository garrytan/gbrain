/**
 * The statements of generations/fence-evidence.ts (#8819, whether a page's `## Facts` fence ever held a fact row) as
 * typed engine members: the fence item keys a fact_fence generation of the page recorded, the probe for a stored
 * version without a body, one batch of the stored versions that carry a facts fence, and the move of kept fact rows
 * off the row numbers a fence row claims. One SQL implementation for both engines; each statement is the text
 * fence-evidence.ts sent through `executeRaw`, with the same parameters and a total row order that sorts text by bytes (`COLLATE "C"`, as PGLite and the Rust engine sort it), on the engine's own
 * `executeRaw` (the move runs on the caller's transaction engine). The ledger and version reads are internal evidence
 * reads of one page, not caller page reads, so they take no page read policy, as the statements never did. The Rust
 * engine serves them from its ledger, version and fact rows (rust/crates/gbrain-store/src/generations/fence_evidence.rs
 * and facts/kept_rows.rs).
 */
import type { EngineRawRead } from './cli-reads-ops.ts';
import type { GenerationRowKey } from './derived-generations.ts';

/** A stored version that carries a facts fence marker. `id` is BIGINT (text on Postgres). */
export interface FenceVersionBodyRow { id: number | string; compiled_truth: string; timeline: string | null }

const RECORDED_ITEM_KEYS_SQL = `SELECT DISTINCT i.item_key COLLATE "C" AS item_key FROM derived_generation_items i
      JOIN derived_generations g ON g.id = i.generation_id
     WHERE g.source_id = $1 AND g.kind = $2 AND g.owner_key = $3 AND g.state <> 'held' AND i.action <> 'retired' AND i.item_key = ANY($4::text[])
     ORDER BY item_key`;

const BODYLESS_VERSION_SQL = `SELECT 1 FROM page_versions v JOIN pages p ON p.id = v.page_id
      WHERE p.source_id = $1 AND p.slug = $2 AND v.compiled_truth IS NULL LIMIT 1`;

const FENCE_VERSIONS_SQL = `SELECT v.id, v.compiled_truth, v.timeline FROM page_versions v
        JOIN pages p ON p.id = v.page_id
       WHERE p.source_id = $1 AND p.slug = $2 AND v.compiled_truth IS NOT NULL AND ($3::bigint IS NULL OR v.id < $3::bigint)
         AND (strpos(v.compiled_truth, 'gbrain:facts:') > 0 OR strpos(COALESCE(v.timeline, ''), 'gbrain:facts:') > 0)
       ORDER BY v.id DESC LIMIT $4`;

const MOVE_KEPT_ROWS_SQL = `UPDATE facts f SET row_num = m.next FROM (
      SELECT k.id, b.top + row_number() OVER (ORDER BY k.row_num, k.id) AS next FROM facts k,
        (SELECT GREATEST(COALESCE((SELECT max(row_num) FROM facts WHERE source_id = $1 AND source_markdown_slug = $2), 0),
          COALESCE((SELECT max(c) FROM unnest($4::integer[]) AS c), 0)) AS top) b
       WHERE k.source_id = $1 AND k.id = ANY($3::bigint[]) AND k.row_num = ANY($4::integer[])) m
    WHERE f.id = m.id`;

/** The item keys of `itemKeys` that a generation of `key` not held records without retiring them. */
export async function listRecordedFenceItemKeys(raw: EngineRawRead, key: GenerationRowKey, itemKeys: readonly string[]): Promise<Array<{ item_key: string }>> {
  return raw<{ item_key: string }>(RECORDED_ITEM_KEYS_SQL, [key.sourceId, key.kind, key.ownerKey, itemKeys]);
}

/** Whether page `slug` of `sourceId` has a stored version without a body (a segmented page's snapshot). */
export async function hasBodylessPageVersion(raw: EngineRawRead, sourceId: string, slug: string): Promise<boolean> {
  return (await raw(BODYLESS_VERSION_SQL, [sourceId, slug])).length > 0;
}

/** Up to `limit` stored versions of the page with a body carrying a facts fence marker, below id `before`, newest first. */
export async function listFenceVersionBodies(raw: EngineRawRead, sourceId: string, slug: string, before: number | null, limit: number): Promise<FenceVersionBodyRow[]> {
  return raw<FenceVersionBodyRow>(FENCE_VERSIONS_SQL, [sourceId, slug, before, limit]);
}

/**
 * Moves the fact rows `ids` of `sourceId` whose row number is one of `claimed` to fresh numbers above every row of the
 * page `slug` and every claimed number, in (row number, id) order.
 */
export async function moveKeptFactRows(raw: EngineRawRead, sourceId: string, slug: string, ids: readonly number[], claimed: readonly number[]): Promise<void> {
  await raw(MOVE_KEPT_ROWS_SQL, [sourceId, slug, [...ids], [...claimed]]);
}
