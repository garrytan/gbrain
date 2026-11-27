/**
 * The idempotency-key rule of `MinionQueue.add` (#5157 / #5114). The fast path
 * and the insert-race resolution run in engine-sql/jobs.ts `admitJob`; both
 * apply `decideCoalesce` to the raw row, so SQL NULL authority stays
 * distinguishable from JSONB null.
 */
import type { BrainEngine } from '../engine.ts';
import { ERROR_CATALOGUE } from '../error-catalogue.ts';
import { OperationError } from '../ops/contract.ts';
import { coalesceDecision, legacyJobAuthorityError, type SubmissionAuthority } from './submission-authority.ts';
import { rowToMinionJob, type MinionJob } from './types.ts';

/**
 * `coalesceDecision`, with a legacy refusal's hint naming the active job ids
 * to cancel first, so the printed recovery runs verbatim.
 */
export async function decideCoalesce(tx: BrainEngine, row: Record<string, unknown>, authority: SubmissionAuthority): Promise<'coalesce' | 'release'> {
  try {
    return coalesceDecision(row, authority);
  } catch (error) {
    if (!(error instanceof OperationError) || error.docs !== ERROR_CATALOGUE.legacy_job_authority.docs) throw error;
    const active = await tx.executeRaw<{ id: number }>("SELECT id FROM minion_jobs WHERE status = 'active' ORDER BY id LIMIT 10");
    throw legacyJobAuthorityError(row, active.map(job => Number(job.id)));
  }
}

/** Fast path: the row already holding `key`, coalesced, or null once a releasable key was freed (or none exists). */
export async function coalesceOnIdempotencyKey(tx: BrainEngine, key: string, authority: SubmissionAuthority): Promise<MinionJob | null> {
  const row = await tx.coalesceOnIdempotencyKey(key, { authority, decide: (t, r) => decideCoalesce(t, r, authority) });
  if (!row) return null;
  const job = rowToMinionJob(row);
  job.coalesced = true;
  return job;
}
