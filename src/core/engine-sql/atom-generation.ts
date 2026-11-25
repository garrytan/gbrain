/**
 * The atom generation ledger of an origin page (src/core/persistence/atom-maintenance.ts): the `op_checkpoints` row
 * `managed-atoms-generation` keyed by page id, which a retirement bumps, and the extraction state the bump drops. Each
 * function runs the statements its caller ran through `executeRaw`, with the same text and parameters; only its home
 * moved.
 */
import type { BrainEngine } from '../engine.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

/**
 * The generation page `pageId`'s content `contentHash` keys on: the kept content keeps the generation its accepted batch
 * used; every other content takes the current one (0 with no ledger row).
 */
export async function readAtomGeneration(raw: Raw, pageId: number, contentHash: string): Promise<number> {
  const [row] = await raw.executeRaw<{ generation: string | null; keep: string | null; keep_generation: string | null }>(
    `SELECT completed_keys->0->>'generation' AS generation, completed_keys->0->>'keep' AS keep, completed_keys->0->>'keep_generation' AS keep_generation
       FROM op_checkpoints WHERE op='managed-atoms-generation' AND fingerprint=$1`, [String(pageId)]);
  if (!row) return 0;
  return Number((row.keep !== null && row.keep === contentHash ? row.keep_generation : row.generation) ?? 0);
}

/**
 * Bumps the page's atom generation (`keepContentHash` keeps `keepGeneration`) and drops the extraction state and the
 * completed managed-atoms runs of every other content of the page.
 */
export async function recordAtomGenerationBump(raw: Raw, sourceId: string, incarnation: string, pageId: number, keepContentHash: string | null,
  keepGeneration: number | null): Promise<void> {
  await raw.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys)
      VALUES('managed-atoms-generation',$1,jsonb_build_array(jsonb_build_object('generation',1,'keep',$2::text,'keep_generation',$3::integer)))
    ON CONFLICT(op,fingerprint) DO UPDATE SET updated_at=now(), completed_keys=jsonb_build_array(jsonb_build_object('generation',
      COALESCE((op_checkpoints.completed_keys->0->>'generation')::integer,0)+1,'keep',$2::text,'keep_generation',$3::integer))`,
  [String(pageId), keepContentHash, keepGeneration]);
  await raw.executeRaw('DELETE FROM extract_atoms_page_state WHERE source_incarnation=$1::uuid AND page_id=$2 AND content_hash IS DISTINCT FROM $3::text',
    [incarnation, pageId, keepContentHash]);
  await raw.executeRaw(`DELETE FROM op_checkpoints WHERE op='managed-atoms' AND completed_keys->0->>'sourceId'=$1
    AND completed_keys->0->>'kind'='page' AND completed_keys->0->>'pageId'=$2 AND completed_keys->0->>'contentHash' IS DISTINCT FROM $3::text`,
  [sourceId, String(pageId), keepContentHash]);
}
