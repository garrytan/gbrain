/**
 * The ledger statements of generations/fence-restore.ts (a fence kind's restore through `gbrain repair generations`)
 * as typed engine members: the fence block each of two generations recorded, the item keys each still owns, and the
 * live generation id an apply rechecks. One SQL implementation for both engines; each statement is the text
 * fence-restore.ts sent through `executeRaw`, with the same parameters and a total row order that sorts text by bytes (`COLLATE "C"`, as PGLite and the Rust engine sort it), on the engine's own
 * `executeRaw`. These are ledger reads, not page reads, so they take no page read policy. The Rust engine serves them
 * from its `derived_generations` rows (rust/crates/gbrain-store/src/generations/fence_restore.rs).
 */
import type { EngineRawRead } from './cli-reads-ops.ts';
import type { GenerationRowKey } from './derived-generations.ts';

/** The fence block a generation recorded (`completeness->'fence'`). `id` is BIGINT (text on Postgres). */
export interface GenerationFenceBlockRow { id: number | string; fence: { body: string | null; timeline: string | null } | null }

/** An item key a generation still owns (any action but `retired`). `generation_id` is BIGINT (text on Postgres). */
export interface GenerationOwnedItemRow { generation_id: number | string; item_key: string }

const FENCE_BLOCKS_SQL = `SELECT id, completeness->'fence' AS fence FROM derived_generations WHERE id = ANY($1::bigint[]) ORDER BY id`;

const OWNED_ITEMS_SQL = `SELECT generation_id, item_key FROM derived_generation_items WHERE generation_id = ANY($1::bigint[]) AND action <> 'retired' ORDER BY generation_id, item_key COLLATE "C"`;

const LIVE_ID_SQL = `SELECT id FROM derived_generations WHERE source_id=$1 AND kind=$2 AND owner_key=$3 AND state='live'`;

/** The recorded fence block of each generation of `generationIds`. */
export async function readGenerationFenceBlocks(raw: EngineRawRead, generationIds: readonly number[]): Promise<GenerationFenceBlockRow[]> {
  return raw<GenerationFenceBlockRow>(FENCE_BLOCKS_SQL, [generationIds]);
}

/** The item keys the generations `generationIds` still own. */
export async function listOwnedGenerationItems(raw: EngineRawRead, generationIds: readonly number[]): Promise<GenerationOwnedItemRow[]> {
  return raw<GenerationOwnedItemRow>(OWNED_ITEMS_SQL, [generationIds]);
}

/** The id of the live generation of `key`, or null. */
export async function readLiveGenerationId(raw: EngineRawRead, key: GenerationRowKey): Promise<{ id: number | string } | null> {
  const [row] = await raw<{ id: number | string }>(LIVE_ID_SQL, [key.sourceId, key.kind, key.ownerKey]);
  return row ?? null;
}
