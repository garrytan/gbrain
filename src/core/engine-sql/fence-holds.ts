/**
 * The fence generation statements (generations/fence.ts) as typed engine members: the held fence results read
 * (`listFenceHolds`) that `gbrain get`, doctor and `gbrain sync status` list, the page reads of a fence publish
 * (`readFenceOriginGone`) and of the held list (`readFenceHoldFiles`), the generation key lock (`lockGenerationKey`)
 * and the hold a readable fence clears (`clearFenceHoldRows`). One SQL implementation for both engines; each statement
 * is the text fence.ts sent through `executeRaw`, byte for byte, on the engine's own `executeRaw`. Only its home moved.
 * The Rust engine reads and clears held rows in its derived generation family and serves the page reads from its pages
 * (store-members/fence-holds.ts).
 */
import type { EngineRawRead } from './cli-reads-ops.ts';

/** A held fence row as `listFenceHolds` reads it; `created_at` is text. */
export interface FenceHoldRow {
  source_id: string;
  kind: string;
  owner_key: string;
  held_reason: string;
  held_context: Record<string, unknown> | null;
  created_at: string;
}

/** `listFenceHoldRows` over every owner: $1 the sources, $2 the fence kinds. Two whole statements, so no placeholder is composed. */
const EVERY_OWNER_SQL = `SELECT source_id, kind, owner_key, held_reason, held_context, created_at::text AS created_at FROM derived_generations
      WHERE source_id = ANY($1::text[]) AND kind = ANY($2::text[]) AND state = 'held'
      ORDER BY created_at, id`;

/** `listFenceHoldRows` for one owner: $3 the owner key. */
const ONE_OWNER_SQL = `SELECT source_id, kind, owner_key, held_reason, held_context, created_at::text AS created_at FROM derived_generations
      WHERE source_id = ANY($1::text[]) AND kind = ANY($2::text[]) AND state = 'held' AND owner_key = $3
      ORDER BY created_at, id`;

/** The held rows of `kinds` in `sourceIds` (one owner with `ownerKey`), oldest first. */
export async function listFenceHoldRows(raw: EngineRawRead, sourceIds: readonly string[], kinds: readonly string[], ownerKey?: string): Promise<FenceHoldRow[]> {
  const params: unknown[] = [[...sourceIds], [...kinds]];
  if (ownerKey !== undefined) params.push(ownerKey);
  return raw<FenceHoldRow>(ownerKey === undefined ? EVERY_OWNER_SQL : ONE_OWNER_SQL, params);
}

/** The fence generation key of `clearFenceHoldRows` (generations/contract.ts GenerationKey). */
export interface FenceHoldKey { sourceId: string; kind: string; ownerKey: string }

/** A held page's file state, as `fenceHoldEntries` reads it: `database_only` when the page records no file. */
export interface FenceHoldFileRow { source_id: string; slug: string; database_only: boolean }

const FENCE_ORIGIN_SQL = 'SELECT deleted_at IS NOT NULL AS deleted FROM pages WHERE source_id=$1 AND slug=$2';
const GENERATION_KEY_LOCK_SQL = 'SELECT pg_advisory_xact_lock(hashtext($1)::bigint)';
const CLEAR_FENCE_HOLD_SQL = `DELETE FROM derived_generations WHERE source_id=$1 AND kind=$2 AND owner_key=$3 AND state='held' AND held_reason IN ('fence_absent','no_proof')`;
const FENCE_HOLD_FILES_SQL = `SELECT source_id, slug, NULLIF(btrim(source_path), '') IS NULL AS database_only FROM pages
      WHERE source_id = ANY($1::text[]) AND slug = ANY($2::text[]) AND deleted_at IS NULL`;

/** Whether `slug` is deleted (or gone) in `sourceId`. */
export async function readFenceOriginGone(raw: EngineRawRead, sourceId: string, slug: string): Promise<boolean> {
  const rows = await raw<{ deleted: boolean }>(FENCE_ORIGIN_SQL, [sourceId, slug]);
  return !rows.length || rows.every(row => row.deleted);
}

/** Holds the generation key `lockKey` until the caller's transaction ends (generations/publish.ts generationKeyLock). */
export async function lockGenerationKey(raw: EngineRawRead, lockKey: string): Promise<void> {
  await raw(GENERATION_KEY_LOCK_SQL, [lockKey]);
}

/** Deletes the `fence_absent` and `no_proof` held rows of `key`. */
export async function clearFenceHoldRows(raw: EngineRawRead, key: FenceHoldKey): Promise<void> {
  await raw(CLEAR_FENCE_HOLD_SQL, [key.sourceId, key.kind, key.ownerKey]);
}

/** The live pages of `slugs` in `sourceIds`, with whether each records no file. */
export async function readFenceHoldFiles(raw: EngineRawRead, sourceIds: readonly string[], slugs: readonly string[]): Promise<FenceHoldFileRow[]> {
  return raw<FenceHoldFileRow>(FENCE_HOLD_FILES_SQL, [[...sourceIds], [...slugs]]);
}
