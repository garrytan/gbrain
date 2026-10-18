/**
 * #6712 PR 2 (L5): the durable obligation of a committed checkpoint's tail (statistics, links; `sync-tail.ts` runs it). The
 * checkpoint's own transaction records it, so a process that dies between that commit and the tail leaves it owed. Kept
 * free of heavy imports: the checkpoint's publication (`sync-prepare.ts`) loads it.
 */
import type { BrainEngine } from '../engine.ts';

export const SYNC_TAIL_OP = 'managed-sync-tail';
/** Obligations kept per source; an older one folds into the stale-page scan every tail runs. */
const SYNC_TAIL_KEEP = 16;

export interface TailObligation { run_id: string; changed: number; extract: boolean; at: string }

/** Inside the checkpoint's transaction: the run's tail is owed before anyone can read the run as synced. */
export async function recordSyncTail(tx: Pick<BrainEngine, 'executeRaw'>, sourceId: string, cursorKey: string, runId: string): Promise<void> {
  await tx.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys,updated_at)
    SELECT $1, $2, jsonb_build_array(jsonb_build_object('run_id',$3::text,'at',now(),
      'changed',COALESCE((c.completed_keys->0->'counts'->>'added')::int,0)+COALESCE((c.completed_keys->0->'counts'->>'modified')::int,0)+COALESCE((c.completed_keys->0->'counts'->>'deleted')::int,0),
      'extract',COALESCE(c.completed_keys->0->'processingOptions'->>'noExtract','false')<>'true' AND c.completed_keys->0->>'companyReceiptId' IS NULL)), now()
    FROM op_checkpoints c WHERE c.op='managed-sync' AND c.fingerprint=$4
    ON CONFLICT (op,fingerprint) DO UPDATE SET updated_at=now(), completed_keys=CASE WHEN jsonb_array_length(op_checkpoints.completed_keys)>=${SYNC_TAIL_KEEP}
      THEN (op_checkpoints.completed_keys-0)||EXCLUDED.completed_keys ELSE op_checkpoints.completed_keys||EXCLUDED.completed_keys END`,
  [SYNC_TAIL_OP, sourceId, runId, cursorKey]);
}

/** The source's owed tail, or null when none is owed. */
export async function readSyncTail(engine: Pick<BrainEngine, 'executeRaw'>, sourceId: string): Promise<TailObligation[] | null> {
  const [row] = await engine.executeRaw<{ completed_keys: TailObligation[] }>('SELECT completed_keys FROM op_checkpoints WHERE op=$1 AND fingerprint=$2', [SYNC_TAIL_OP, sourceId]);
  return row?.completed_keys?.length ? row.completed_keys : null;
}
