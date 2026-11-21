import type { BrainEngine } from '../engine.ts';
import type { PageSnapshot } from '../page-state/types.ts';
import { opError } from '../ops/contract.ts';

/** Plain-directory sync has no Git preimage. Retain the last file publication's
 * page identity and revision, scoped to the source incarnation, instead. */
const OP = 'plain-directory-import';

export async function assertPlainImportBaseline(engine: BrainEngine, sourceId: string, path: string, snapshot: PageSnapshot | null, unchanged: boolean): Promise<void> {
  if (!snapshot || unchanged) return;
  const [row] = await engine.executeRaw<{ baseline: { page_id: number; revision: string } }>(
    `SELECT c.completed_keys->0 AS baseline FROM op_checkpoints c JOIN sources s
      ON c.fingerprint=s.id||':'||s.incarnation::text||':'||$2 WHERE s.id=$1 AND c.op=$3`, [sourceId, path, OP]);
  if (row?.baseline.page_id === snapshot.page.id && String(row.baseline.revision) === String(snapshot.revision)) return;
  throw opError('source_changed', 'Plain-directory sync will not overwrite a page changed outside its last file import.',
    `Compare ${path} with page ${snapshot.page.slug} in source ${sourceId}. Keep the database edit by updating the file to match, or explicitly import the reviewed file with gbrain import to choose its contents. Nothing was published for this file.`,
    { detail: 'file_database_drift' });
}

/** After the final page write in its publication transaction, or for a validated
 * equal-content no-op using only the observed snapshot (never a fresh read). */
export async function recordPlainImportBaseline(engine: BrainEngine, sourceId: string, path: string, snapshot: PageSnapshot | null): Promise<void> {
  if (!snapshot) return;
  await engine.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys)
    SELECT $3,id||':'||incarnation::text||':'||$2,jsonb_build_array(jsonb_build_object('source_id',id,'incarnation',incarnation::text,'page_id',$4::bigint,'revision',$5::text)) FROM sources WHERE id=$1
    ON CONFLICT(op,fingerprint) DO UPDATE SET completed_keys=EXCLUDED.completed_keys,updated_at=now()
    WHERE op_checkpoints.completed_keys IS DISTINCT FROM EXCLUDED.completed_keys`,
  [sourceId, path, OP, snapshot.page.id, snapshot.revision]);
}
