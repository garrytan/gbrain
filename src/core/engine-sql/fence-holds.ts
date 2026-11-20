/**
 * The held fence results read (generations/fence.ts `listFenceHolds`): the `derived_generations` rows a facts or takes
 * fence publish holds, as `gbrain get`, doctor and `gbrain sync status` list them; and the delete of a held row a
 * readable fence answers (`clearFenceHold`). One SQL implementation for both
 * engines; the statement is the text `listFenceHolds` sent through `executeRaw`, byte for byte, on the engine's own
 * `executeRaw`; so does the delete's. Only its home moved. The Rust engine holds no fence results (store-members/fence-holds.ts).
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

/** `clearFenceHoldRows`: the statement `clearFenceHold` sent through `executeRaw`. */
const CLEAR_HOLD_SQL = `DELETE FROM derived_generations WHERE source_id=$1 AND kind=$2 AND owner_key=$3 AND state='held' AND held_reason IN ('fence_absent','no_proof')`;

/** Deletes the owner's held `fence_absent` or `no_proof` row of `kind` in `sourceId` (generations/fence.ts `clearFenceHold`). */
export async function clearFenceHoldRows(raw: (sql: string, params: unknown[]) => Promise<unknown>, sourceId: string, kind: string, ownerKey: string): Promise<void> {
  await raw(CLEAR_HOLD_SQL, [sourceId, kind, ownerKey]);
}
