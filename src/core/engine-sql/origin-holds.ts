/**
 * The statements of a purge's derived-origin parks and owed-purge records (persistence/derived-origin-hold.ts
 * `parkDerivedOrigin`, `recordOwedPurge`, `clearOwedPurges` and `clearDerivedOriginParks`; repair/origin-carry.ts
 * `parkUncarriedInPurge`). Each ran through `executeRaw`; SQL once for both engines, so the Rust store serves the same
 * members (src/core/rust-engine/store-members/page-purge-holds.ts).
 *
 * Every function takes the engine (or transaction) it runs on and runs through `executeRaw` on it, so inside a purge
 * transaction the write is part of that transaction. The records are `op_checkpoints` rows (op `derived-origin-park` or
 * `owed-page-purge`, fingerprint the page id, one document at `completed_keys -> 0`). Static text.
 *
 * `listPurgeOrigins` reads the privacy rules (`privacyPartSql`), which follow the process's alias-honoring setting
 * (`readHonorAliases`): the caller reads it first.
 */
import type { BrainEngine } from '../engine.ts';
import { DERIVED_ORIGIN_PARK_OP, OWED_PURGE_OP, derivedOriginPurgeHold, type DerivedOriginPark } from '../persistence/derived-origin-hold.ts';
import { privacyPartSql } from '../search/private-visibility.ts';
import type { OriginRefInput } from './label-door.ts';
import { renderFragment, sqlFragment, trustedSql } from './fragment.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

const bounded = { timeoutMs: 120_000, jitOff: true, prepare: false };

/** What `recordOwedPurgeRows` wrote: the owed-purge record rows and the park rows it bound to the tombstone. */
export interface OwedPurgeRows { owed: number; held: number }

/**
 * The pages among `ids` that are privacy origins (an atom, or a page the privacy rules hide), by id; unless `recheckParked`,
 * the ones an origin park already holds are left out.
 */
export async function listPurgeOrigins(engine: Raw, ids: readonly number[], recheckParked: boolean): Promise<OriginRefInput[]> {
  const idList = [...ids];
  const { text, params } = renderFragment(recheckParked
    ? sqlFragment`SELECT p.id, p.source_id, p.slug FROM pages p
      WHERE p.id = ANY(${idList}::int[]) AND (p.type = 'atom' OR NOT ${trustedSql(privacyPartSql('p'))}) ORDER BY p.id`
    : sqlFragment`SELECT p.id, p.source_id, p.slug FROM pages p
      WHERE p.id = ANY(${idList}::int[]) AND (p.type = 'atom' OR NOT ${trustedSql(privacyPartSql('p'))}) AND ${trustedSql(derivedOriginPurgeHold('p'))} ORDER BY p.id`);
  const rows = await engine.executeRaw<{ id: number; source_id: string; slug: string }>(text, params, bounded);
  return rows.map(row => ({ id: Number(row.id), source_id: row.source_id, slug: row.slug }));
}

/**
 * Writes the park of page `pageId` (`park` is the whole document, stamped by the caller). A park of the same page that held an
 * owner's purge keeps it (`held_request_id`, `held_deleted_us`) when the new document names none, and the new one replaces it
 * when it does. Writes op_checkpoints; run it in the purge transaction.
 */
export async function upsertDerivedOriginPark(engine: Raw, pageId: number, park: DerivedOriginPark): Promise<void> {
  await engine.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES($1,$2,$3::text::jsonb)
    ON CONFLICT (op,fingerprint) DO UPDATE SET updated_at=now(), completed_keys=CASE WHEN (op_checkpoints.completed_keys->0) ? 'held_request_id' AND NOT (EXCLUDED.completed_keys->0) ? 'held_request_id'
      THEN jsonb_build_array((EXCLUDED.completed_keys->0) || jsonb_strip_nulls(jsonb_build_object('held_request_id', op_checkpoints.completed_keys->0->'held_request_id',
        'held_deleted_us', op_checkpoints.completed_keys->0->'held_deleted_us'))) ELSE EXCLUDED.completed_keys END`, [DERIVED_ORIGIN_PARK_OP, String(pageId), JSON.stringify([park])]);
}

/**
 * Records that the owner's purge `requestId` is owed for page `pageId`'s current tombstone (a page that is not a tombstone records
 * nothing, and a record already for that tombstone stays), and binds the park that holds the same request to that tombstone.
 * Writes op_checkpoints; run it in the purge transaction.
 */
export async function recordOwedPurgeRows(engine: Raw, pageId: number, requestId: string): Promise<OwedPurgeRows> {
  const owed = await engine.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys)
    SELECT $1, p.id::text, jsonb_build_array(jsonb_build_object('source_id', p.source_id, 'page_id', p.id, 'deleted_us', floor(extract(epoch FROM p.deleted_at)*1000000)::bigint::text, 'request_id', $3::text))
    FROM pages p WHERE p.id = $2 AND p.deleted_at IS NOT NULL
    ON CONFLICT (op,fingerprint) DO UPDATE SET updated_at=now(), completed_keys=EXCLUDED.completed_keys
      WHERE op_checkpoints.completed_keys->0->>'deleted_us' IS DISTINCT FROM EXCLUDED.completed_keys->0->>'deleted_us' RETURNING 1`, [OWED_PURGE_OP, pageId, requestId]);
  const held = await engine.executeRaw(`UPDATE op_checkpoints o SET updated_at=now(), completed_keys=jsonb_set(o.completed_keys, '{0,held_deleted_us}', to_jsonb(floor(extract(epoch FROM p.deleted_at)*1000000)::bigint::text))
    FROM pages p WHERE o.op=$1 AND o.fingerprint=p.id::text AND p.id=$2 AND p.deleted_at IS NOT NULL AND o.completed_keys->0->>'held_request_id' = $3::text RETURNING 1`,
  [DERIVED_ORIGIN_PARK_OP, pageId, requestId]);
  return { owed: owed.length, held: held.length };
}

/**
 * Removes the records of op `op` (`derived-origin-park` or `owed-page-purge`) for these pages; how many it removed. The purge that
 * removes a page calls it in its transaction. Writes op_checkpoints.
 */
export async function deleteOriginHoldRows(engine: Raw, op: typeof DERIVED_ORIGIN_PARK_OP | typeof OWED_PURGE_OP, pageIds: readonly number[]): Promise<number> {
  return (await engine.executeRaw('DELETE FROM op_checkpoints WHERE op=$1 AND fingerprint = ANY($2::text[]) RETURNING 1', [op, pageIds.map(String)])).length;
}
