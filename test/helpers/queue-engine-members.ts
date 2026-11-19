/**
 * The minion queue's engine members (engine-sql/jobs-queue.ts) for a hand-built fake engine.
 *
 * Hermetic queue and worker tests script a fake `executeRaw`. Since the queue's statements moved into engine members,
 * `MinionQueue` calls `engine.listUnreviewedJobs()`, `engine.promoteDelayedJobs()` and the rest; this adds each member
 * the fake does not define, running the shared statement on the fake itself, as PGLite and Postgres do. A multi-statement
 * member runs without the engine's transaction, which a scripted fake has no use for. The status reads
 * (engine-sql/jobs-status.ts) are added the same way.
 */
import * as jobsQueue from '../../src/core/engine-sql/jobs-queue.ts';
import * as jobsHealth from '../../src/core/engine-sql/jobs-health.ts';
import * as jobsStatus from '../../src/core/engine-sql/jobs-status.ts';
import * as jobsSpend from '../../src/core/engine-sql/jobs-spend.ts';

const MEMBERS = [
  'deleteTerminalJob', 'pauseJob', 'resumeJob', 'failParentJob', 'resolveParentJob', 'resolveStrandedParents', 'detachChildJob',
  'updateJobProgress', 'addJobTokens', 'delayActiveJob', 'releaseWatchdogClaim', 'markJobWatchdogSuspect',
  'promoteDelayedJobs', 'cancelJobs', 'killTimedOutJobs', 'killWallClockJobs', 'pruneJobs', 'retryJob',
  'listSynthesisCompletionKeys', 'listRecentSynthesisCompletions',
  'postInboxMessage', 'readJobInbox', 'readChildCompletions',
  'listOpenJobIdsInQueue', 'renewPrivateQueueLease', 'listOwnedPrivateQueues', 'readPrivateQueueState',
  'listStaleWaitingJobIds', 'countTtlExpiredWaiting', 'readJobStats', 'readQueueFamilyStats', 'hasOverdueWatchdogSuspect',
  'listUnreviewedJobs', 'getFailedJobForRetry', 'countOpenJobsByOwner', 'readJobSourceState', 'lockOAuthClient', 'listJobPage',
  'listJobAttachmentNames', 'insertJobAttachment', 'listJobAttachments', 'getJobAttachment', 'deleteJobAttachment',
] as const satisfies ReadonlyArray<keyof typeof jobsQueue>;

/** The queue-health reads (engine-sql/jobs-health.ts), added the same way. */
const HEALTH_MEMBERS = [
  'readQueueHealthSignals', 'listWaitingByQueue', 'readQueueDivergence', 'listQueueWedgeCounts', 'listPrivateQueueHealth',
  'readWedgeSignals', 'readOldestWaitingAge', 'listStuckActiveJobsByName',
] as const satisfies ReadonlyArray<keyof typeof jobsHealth>;

/** The status reads (engine-sql/jobs-status.ts), added the same way. */
const STATUS_MEMBERS = [
  'readLastAutopilotCycles', 'countJobsByStatus', 'readWaitingQueueDepths', 'readLastCompletedJobAt', 'countTtlCancelledByName',
  'readWaitingScopeState', 'countRecentCompletedJobs', 'listRecentFailedJobErrors', 'readQueuedPageChars', 'readSourceJobCounts',
  'readEmbedBackfillBySource',
] as const satisfies ReadonlyArray<keyof typeof jobsStatus>;

/** The spend reservations and the lease-pressure log (engine-sql/jobs-spend.ts), added the same way (group C). */
const SPEND_MEMBERS = [
  'readJobSpendTree', 'insertSpendReservation', 'expireSpendReservations', 'settleSpendReservation', 'markSpendUsageUnknown',
  'insertLeasePressure', 'countLeasePressure', 'listRecentLeasePressure',
] as const satisfies ReadonlyArray<keyof typeof jobsSpend>;

/** `fake` with every queue member it lacks, each running the shared statement on `fake`. */
export function withQueueMembers<T extends object>(fake: T): T {
  const target = fake as Record<string, unknown>;
  for (const name of MEMBERS) {
    if (name in target) continue;
    const member = jobsQueue[name] as (tx: unknown, ...args: unknown[]) => unknown;
    target[name] = (...args: unknown[]) => member(fake, ...args);
  }
  for (const name of HEALTH_MEMBERS) {
    if (name in target) continue;
    const member = jobsHealth[name] as (tx: unknown, ...args: unknown[]) => unknown;
    target[name] = (...args: unknown[]) => member(fake, ...args);
  }
  for (const name of STATUS_MEMBERS) {
    if (name in target) continue;
    const member = jobsStatus[name] as (tx: unknown, ...args: unknown[]) => unknown;
    target[name] = (...args: unknown[]) => member(fake, ...args);
  }
  for (const name of SPEND_MEMBERS) {
    if (name in target) continue;
    const member = jobsSpend[name] as (tx: unknown, ...args: unknown[]) => unknown;
    target[name] = (...args: unknown[]) => member(fake, ...args);
  }
  return fake;
}
