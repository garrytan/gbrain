/** Queue-side forwarders for submission authority, including owner-minted local subagent ceilings. */
import type { BrainEngine } from '../engine.ts';
import { opError } from '../ops/contract.ts';
import { lockDelegatedSubmission } from './delegated-admission.ts';
import { assertLocalSubagentLive, localSubagentAdmission } from './local-subagent.ts';
import {
  APPLICATION_AUTHORITY, authorizeJobExecution, currentSubmissionAuthority, parseSubmissionAuthority, withSubmissionAuthority,
  type SubmissionAuthority,
} from './submission-authority.ts';
import type { TrustedSubmitOpts } from './queue.ts';
import type { MinionJob } from './types.ts';

/** Resolve who is submitting: descendants of remote jobs are refused; a local admission token wins over a stored descriptor. */
export function resolveSubmissionAuthority(engine: BrainEngine, trusted: TrustedSubmitOpts | undefined): SubmissionAuthority {
  if (currentSubmissionAuthority() && currentSubmissionAuthority()!.kind !== 'application') throw new Error('Remote jobs cannot submit descendant jobs');
  const localAdmission = localSubagentAdmission(engine, trusted);
  const authority = localAdmission ?? parseSubmissionAuthority(trusted?.submissionAuthority ?? APPLICATION_AUTHORITY);
  if (!authority || authority.kind === 'local_subagent' && !localAdmission) throw new Error('Unsupported submission authority');
  return authority;
}

/** In-transaction lock: a local ceiling must still be live before the delegated-client lock is taken. */
export async function lockSubmission(
  tx: BrainEngine, authority: SubmissionAuthority, clientId: string | undefined, name: string, data?: Record<string, unknown>,
): Promise<number | null> {
  if (authority.kind === 'local_subagent') await assertLocalSubagentLive(tx, authority, true);
  return lockDelegatedSubmission(tx, clientId, name, data);
}

/** Bind a freshly inserted local subagent job to the ceiling that admitted it. */
export async function bindLocalSubagentJob(tx: BrainEngine, child: MinionJob, authority: SubmissionAuthority): Promise<MinionJob> {
  if (authority.kind !== 'local_subagent') return child;
  const bound = { ...authority, acceptedJobId: child.id };
  await tx.executeRaw('UPDATE minion_jobs SET submission_authority=$2::text::jsonb WHERE id=$1', [child.id, JSON.stringify(bound)]);
  child.submission_authority = bound;
  return child;
}

/**
 * Replay authorization. A local_subagent ceiling is an admission-only capability minted by the verified owner
 * for one accepted job; a stored descriptor is never an admission token, so replay refuses before it
 * authorizes or inserts anything.
 */
export async function authorizeReplaySource(engine: BrainEngine, source: MinionJob): Promise<SubmissionAuthority> {
  if (source.submission_authority?.kind === 'local_subagent') {
    throw opError('permission_denied', `Job ${source.id} is a local subagent job; its owner-minted authority cannot be replayed from the stored job.`,
      'Nothing was submitted. Rerun the original owner-authorized `gbrain hermes maintain` request (same --source and budget flags) from the verified local CLI so fresh bounded authority is minted; do not replay or edit the stored job.');
  }
  return authorizeJobExecution(engine, source);
}

/** Authorize a claimed job, then run `fn` with that authority (and the job signal) in scope. */
export async function runWithJobAuthority<T>(
  engine: BrainEngine, job: Parameters<typeof authorizeJobExecution>[1], fn: () => T, signal?: AbortSignal,
): Promise<Awaited<T>> {
  return await withSubmissionAuthority(await authorizeJobExecution(engine, job), fn, signal);
}
