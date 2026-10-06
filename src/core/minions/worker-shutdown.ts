/**
 * #5062: settling a worker's claims when it shuts down. A claim whose handler
 * ended because of the shutdown (the shell handler terminated its process
 * group), or that is still running when the 30s drain expires, goes back to
 * the queue token-fenced with no attempt burned, instead of sitting `active`
 * until its lease expires and the stall sweep charges a stall.
 */
import type { BrainEngine } from '../engine.ts';
import type { MinionJob } from './types.ts';

/** Hand one claim back to `waiting`. False when the claim already moved on. */
export async function releaseShutdownClaim(engine: BrainEngine, id: number, lockToken: string): Promise<boolean> {
  const rows = await engine.executeRaw<{ id: number }>(
    `UPDATE minion_jobs SET
      status = 'waiting',
      error_text = 'worker_shutdown',
      started_at = NULL, timeout_at = NULL,
      lock_token = NULL, lock_until = NULL, updated_at = now()
     WHERE id = $1 AND status = 'active' AND lock_token = $2
     RETURNING id`,
    [id, lockToken],
  );
  return rows.length > 0;
}

/**
 * A handler ended during shutdown. `stopped` is false only for an isolated
 * child whose termination was not confirmed; that claim is left for the
 * stall sweep so a still-running child cannot overlap a new claimant.
 */
export async function settleShutdownInterruptedJob(
  engine: BrainEngine, job: MinionJob, lockToken: string, errorText: string, stopped: boolean,
): Promise<void> {
  if (!stopped) {
    console.log(`Job ${job.id} (${job.name}) released after worker shutdown (${errorText}); stall detector will requeue (no attempt burned)`);
    return;
  }
  try {
    const released = await releaseShutdownClaim(engine, job.id, lockToken);
    console.log(`Job ${job.id} (${job.name}) ${released ? 'handed back to the queue' : 'claim already moved on'} after worker shutdown (${errorText}; no attempt burned)`);
  } catch (e) {
    console.error(`[worker] shutdown release failed for job ${job.id}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * After a shutdown's drain window: hand back every claim still held. Returns
 * true when any was. Called only when shutdown was requested (the process is
 * about to exit); a cooperative `stop()` keeps its claims, whose handlers are
 * still running in this process. With `isolated`, a child whose termination
 * was not confirmed is skipped: the stall sweep owns that claim.
 */
export async function releaseUndrainedClaims(
  engine: BrainEngine, executions: Iterable<{ job: MinionJob; lockToken: string; stopped: boolean }>, isolated: boolean,
): Promise<boolean> {
  let any = false;
  for (const { job, lockToken, stopped } of executions) {
    if (isolated && !stopped) continue;
    any = true;
    try {
      const released = await releaseShutdownClaim(engine, job.id, lockToken);
      console.warn(`Job ${job.id} (${job.name}) did not finish within the shutdown drain; ${released ? 'handed back to the queue (no attempt burned).' : 'claim already moved on (lock token mismatch).'}`);
    } catch (e) {
      console.error(`[worker] shutdown release failed for job ${job.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return any;
}
