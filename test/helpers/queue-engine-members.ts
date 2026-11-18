/**
 * The minion queue's engine members (engine-sql/jobs-queue.ts) for a hand-built fake engine.
 *
 * Hermetic queue and worker tests script a fake `executeRaw`. Since the queue's statements moved into engine members,
 * `MinionQueue` calls `engine.listUnreviewedJobs()`, `engine.promoteDelayedJobs()` and the rest; this adds each member
 * the fake does not define, running the shared statement on the fake itself, as PGLite and Postgres do. A multi-statement
 * member runs without the engine's transaction, which a scripted fake has no use for.
 */
import * as jobsQueue from '../../src/core/engine-sql/jobs-queue.ts';

const MEMBERS = [
  'deleteTerminalJob', 'pauseJob', 'resumeJob', 'failParentJob', 'resolveParentJob', 'resolveStrandedParents', 'detachChildJob',
  'updateJobProgress', 'addJobTokens', 'delayActiveJob', 'releaseWatchdogClaim', 'markJobWatchdogSuspect',
  'promoteDelayedJobs', 'cancelJobs', 'killTimedOutJobs', 'killWallClockJobs', 'pruneJobs', 'retryJob',
  'postInboxMessage', 'readJobInbox', 'readChildCompletions',
  'listOpenJobIdsInQueue', 'renewPrivateQueueLease', 'listOwnedPrivateQueues', 'readPrivateQueueState',
  'listStaleWaitingJobIds', 'countTtlExpiredWaiting', 'readJobStats', 'readQueueFamilyStats', 'hasOverdueWatchdogSuspect',
  'listUnreviewedJobs', 'getFailedJobForRetry', 'listJobPage',
  'listJobAttachmentNames', 'insertJobAttachment', 'listJobAttachments', 'getJobAttachment', 'deleteJobAttachment',
] as const satisfies ReadonlyArray<keyof typeof jobsQueue>;

/** `fake` with every queue member it lacks, each running the shared statement on `fake`. */
export function withQueueMembers<T extends object>(fake: T): T {
  const target = fake as Record<string, unknown>;
  for (const name of MEMBERS) {
    if (name in target) continue;
    const member = jobsQueue[name] as (tx: unknown, ...args: unknown[]) => unknown;
    target[name] = (...args: unknown[]) => member(fake, ...args);
  }
  return fake;
}
