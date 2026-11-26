import type { BrainEngine } from '../engine.ts';
import { rowToMinionJob, type MinionJob } from '../minions/types.ts';

/** Use the claim's session pool so the read is independent of the transaction pool. */
export async function findLiveMinionClaim(
  direct: Pick<BrainEngine, 'executeRawDirect'>, queue: string, lockToken: string,
): Promise<MinionJob | null> {
  const [row] = await direct.executeRawDirect<Record<string, unknown>>(
    `SELECT * FROM minion_jobs
     WHERE queue = $1 AND status = 'active' AND lock_token = $2 AND lock_until > now()
     LIMIT 1`,
    [queue, lockToken],
  );
  return row ? rowToMinionJob(row) : null;
}
