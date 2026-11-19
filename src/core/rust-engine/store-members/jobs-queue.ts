/**
 * Minion queue members beyond admission and the claim loop (engine-sql/jobs-queue.ts): single-job writes, the sweeps,
 * the inbox, private-queue recovery reads, the stats and list reads, and attachments. The store keeps the rows
 * (rust/docs/store/jobs.md); timestamps cross the binding as ISO strings and come back as `Date`s, as PGLite returns them.
 */
import type { BrainEngine } from '../../engine.ts';
import type { JobRow } from '../../engine-sql/jobs.ts';
import {
  DREAM_INLINE_PRIVATE_QUEUE_PREFIX,
  type CancelJobsSpec, type DelayActiveJobSpec, type JobAttachmentInsert, type JobPageSpec, type JobStatsRead,
  type JobTokenCounts, type PrivateQueueState, type PruneJobsSpec, type QueueFamilyRow, type RetryJobPolicy,
  type JobSourceState, type SynthesisCompletion, type SynthesisCompletionPrefix,
} from '../../engine-sql/jobs-queue.ts';
import { WATCHDOG_SUSPECT_MARK } from '../../minions/watchdog-attribution.ts';
import { delegatedPolicyHandle } from '../delegated-policy-handle.ts';
import { withDates } from '../store-codec.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';

/** The `timestamptz` columns of `minion_jobs`, `minion_inbox` and `minion_attachments`. */
const JOB_DATES = ['lock_until', 'delay_until', 'timeout_at', 'private_queue_lease_until', 'created_at', 'started_at', 'finished_at', 'updated_at'] as const;
const INBOX_DATES = ['sent_at', 'read_at'] as const;
const ATTACHMENT_DATES = ['created_at'] as const;

const jobRow = (row: JobRow | null | undefined): JobRow | null => (row ? withDates(row, JOB_DATES) : null);
const jobRows = (rows: JobRow[]): JobRow[] => rows.map(r => withDates(r, JOB_DATES));

/** The store's attachment row with `content_b64` turned into the `content` bytes PGLite returns. */
function attachmentRow(row: JobRow): JobRow {
  const { content_b64, ...meta } = row as JobRow & { content_b64?: string };
  const out = withDates(meta as JobRow, ATTACHMENT_DATES);
  return content_b64 === undefined ? out : { ...out, content: Buffer.from(content_b64, 'base64') };
}

const call = <T>(member: string, run: () => Promise<T>): Promise<T> => storeCall({ member }, run);

// ---------------------------------------------------------------- writes on one job

export const deleteTerminalJob: StoreMember<[id: number], boolean> = (brain, id) => call('deleteTerminalJob', () => brain.deleteTerminalJob(id));

export const pauseJob: StoreMember<[id: number], JobRow | null> = async (brain, id) => jobRow(await call('pauseJob', () => brain.pauseJob(id)));

export const resumeJob: StoreMember<[id: number], JobRow | null> = async (brain, id) => jobRow(await call('resumeJob', () => brain.resumeJob(id)));

export const failParentJob: StoreMember<[parentId: number, errorText: string], JobRow | null> = async (brain, parentId, errorText) =>
  jobRow(await call('failParentJob', () => brain.failParentJob(parentId, errorText)));

export const resolveParentJob: StoreMember<[parentId: number], JobRow | null> = async (brain, parentId) =>
  jobRow(await call('resolveParentJob', () => brain.resolveParentJob(parentId)));

export const resolveStrandedParents: StoreMember<[], number> = (brain) => call('resolveStrandedParents', () => brain.resolveStrandedParents());

export const detachChildJob: StoreMember<[childId: number], void> = async (brain, childId) => {
  await call('detachChildJob', () => brain.detachChildJob(childId));
};

export const updateJobProgress: StoreMember<[id: number, lockToken: string, progress: unknown], boolean> = (brain, id, lockToken, progress) =>
  call('updateJobProgress', () => brain.updateJobProgress(id, lockToken, progress ?? null));

export const addJobTokens: StoreMember<[id: number, lockToken: string, tokens: JobTokenCounts], boolean> = (brain, id, lockToken, tokens) =>
  call('addJobTokens', () => brain.addJobTokens(id, lockToken, tokens));

/** The store's write is not interrupted, as a write already sent to the database is not; a signal is ignored. */
export const delayActiveJob: StoreMember<[id: number, lockToken: string, spec: DelayActiveJobSpec, opts?: { signal?: AbortSignal }], JobRow | null> =
  async (brain, id, lockToken, spec) => jobRow(await call('delayActiveJob', () => brain.delayActiveJob(id, lockToken, spec)));

export const releaseWatchdogClaim: StoreMember<[id: number, lockToken: string, errorText: string], boolean> = (brain, id, lockToken, errorText) =>
  call('releaseWatchdogClaim', () => brain.releaseWatchdogClaim(id, lockToken, errorText, WATCHDOG_SUSPECT_MARK));

export const markJobWatchdogSuspect: StoreMember<[id: number], void> = async (brain, id) => {
  await call('markJobWatchdogSuspect', () => brain.markJobWatchdogSuspect(id, WATCHDOG_SUSPECT_MARK));
};

// ---------------------------------------------------------------- sweeps

export const promoteDelayedJobs: StoreMember<[], JobRow[]> = async (brain) => jobRows(await call('promoteDelayedJobs', () => brain.promoteDelayedJobs()));

export const cancelJobs: StoreMember<[ids: readonly number[], spec?: CancelJobsSpec], JobRow[]> = async (brain, ids, spec) =>
  jobRows(await call('cancelJobs', () => brain.cancelJobs([...ids], spec ?? null)));

export const killTimedOutJobs: StoreMember<[], JobRow[]> = async (brain) => jobRows(await call('killTimedOutJobs', () => brain.killTimedOutJobs()));

export const killWallClockJobs: StoreMember<[lockDurationMs: number], JobRow[]> = async (brain, lockDurationMs) =>
  jobRows(await call('killWallClockJobs', () => brain.killWallClockJobs(lockDurationMs)));

/**
 * A pruned completed dream synthesis child's key goes into the store's `dream_synthesis_completions` archive in the
 * delete's transaction, as the SQL engines' `archived` CTE does. A dry run only counts.
 */
export const pruneJobs: StoreMember<[spec: PruneJobsSpec], number> = async (brain, spec) => {
  const out: { count: number } = await call('pruneJobs', () =>
    brain.pruneJobs({ statuses: [...spec.statuses], olderThan: spec.olderThan.toISOString(), dryRun: spec.dryRun === true }));
  return out.count;
};

/** The store returns the keys sorted; the SQL engines' `UNION` has no set order. */
export const listSynthesisCompletionKeys: StoreMember<[sourceId: string, keyPrefix: SynthesisCompletionPrefix], string[]> =
  (brain, sourceId, keyPrefix) => call('listSynthesisCompletionKeys', () => brain.listSynthesisCompletionKeys(sourceId, keyPrefix));

export const listRecentSynthesisCompletions: StoreMember<[sourceId: string, hours: number], SynthesisCompletion[]> = async (brain, sourceId, hours) =>
  (await call('listRecentSynthesisCompletions', () => brain.listRecentSynthesisCompletions(sourceId, hours)) as SynthesisCompletion[])
    .map(r => withDates(r, ['at']));

/**
 * The retry policy runs on the delegated policy handle (../delegated-policy-handle.ts): the job reads and the client's
 * open-job count; the client's grant read (readOauthClient), and anything else, refuses before the store writes. A policy that
 * took the client lock refuses too, since the lock holds nothing across store calls. The store's UPDATE re-checks that
 * the job is still failed or dead.
 */
export const retryJob: StoreMember<[id: number, policy: RetryJobPolicy], JobRow | null> = async (brain, id, policy) => {
  const prior = jobRow(await call('retryJob', () => brain.getJob(id)));
  if (!prior) return null;
  const handle = delegatedPolicyHandle(brain, 'retryJob');
  if (!await policy.admit(handle.tx, prior)) return null;
  if (handle.locked()) refuseMember('retryJob', 'delegated client admission across store calls');
  return jobRow(await call('retryJob', () => brain.retryJobUpdate(id)));
};

// ---------------------------------------------------------------- inbox

export const postInboxMessage: StoreMember<[jobId: number, sender: string, payload: unknown], JobRow> = async (brain, jobId, sender, payload) =>
  withDates(await call('postInboxMessage', () => brain.postInboxMessage(jobId, sender, payload ?? null)) as JobRow, INBOX_DATES);

export const readJobInbox: StoreMember<[jobId: number, lockToken: string], JobRow[]> = async (brain, jobId, lockToken) =>
  (await call('readJobInbox', () => brain.readJobInbox(jobId, lockToken)) as JobRow[]).map(r => withDates(r, INBOX_DATES));

export const readChildCompletions: StoreMember<[parentId: number, lockToken: string, since?: Date | null], unknown[]> = (brain, parentId, lockToken, since) =>
  call('readChildCompletions', () => brain.readChildCompletions(parentId, lockToken, since ? since.toISOString() : null));

// ---------------------------------------------------------------- private queues

export const listOpenJobIdsInQueue: StoreMember<[queue: string], number[]> = (brain, queue) => call('listOpenJobIdsInQueue', () => brain.listOpenJobIdsInQueue(queue));

export const renewPrivateQueueLease: StoreMember<[queue: string, ownerToken: string, leaseMs: number], number> = (brain, queue, ownerToken, leaseMs) =>
  call('renewPrivateQueueLease', () => brain.renewPrivateQueueLease(queue, ownerToken, leaseMs));

export const listOwnedPrivateQueues: StoreMember<[maxQueues: number], string[]> = (brain, maxQueues) =>
  call('listOwnedPrivateQueues', () => brain.listOwnedPrivateQueues(DREAM_INLINE_PRIVATE_QUEUE_PREFIX, maxQueues));

export const readPrivateQueueState: StoreMember<[queue: string], PrivateQueueState> = (brain, queue) =>
  call('readPrivateQueueState', () => brain.readPrivateQueueState(queue));

// ---------------------------------------------------------------- reads

export const listStaleWaitingJobIds: StoreMember<[name: string, hours: number, limit: number], number[]> = (brain, name, hours, limit) =>
  call('listStaleWaitingJobIds', () => brain.listStaleWaitingJobIds(name, hours, limit));

export const countTtlExpiredWaiting: StoreMember<[name: string, hours: number], number> = (brain, name, hours) =>
  call('countTtlExpiredWaiting', () => brain.countTtlExpiredWaiting(name, hours));

export const readJobStats: StoreMember<[since: Date, queue: string], JobStatsRead> = (brain, since, queue) =>
  call('readJobStats', () => brain.readJobStats(since.toISOString(), queue));

export const readQueueFamilyStats: StoreMember<[since: Date], QueueFamilyRow[]> = (brain, since) =>
  call('readQueueFamilyStats', () => brain.readQueueFamilyStats(since.toISOString(), DREAM_INLINE_PRIVATE_QUEUE_PREFIX));

export const hasOverdueWatchdogSuspect: StoreMember<[queue: string, names: readonly string[], waitMs: number], boolean> = async (brain, queue, names, waitMs) => {
  if (names.length === 0) return false;
  return call('hasOverdueWatchdogSuspect', () => brain.hasOverdueWatchdogSuspect({ queue, names: [...names], mark: WATCHDOG_SUSPECT_MARK, waitMs }));
};

export const listUnreviewedJobs: StoreMember<[], Array<{ id: number; submission_authority: unknown }>> = (brain) =>
  call('listUnreviewedJobs', () => brain.listUnreviewedJobs());

export const getFailedJobForRetry: StoreMember<[id: number], { name: string; data: Record<string, unknown> } | null> = (brain, id) =>
  call('getFailedJobForRetry', () => brain.getFailedJobForRetry(id));

/**
 * A delegated client's open `subagent` jobs. Its pair `lockOAuthClient` is not served: the store keeps no
 * `oauth_clients` rows to lock, so a direct call refuses.
 */
export const countOpenJobsByOwner: StoreMember<[clientId: string], number> = (brain, clientId) =>
  call('countOpenJobsByOwner', () => brain.countOpenJobsByOwner(clientId));

/** An agent job's source (archived, created_at), or null; the store reads the source record. */
export const readJobSourceState: StoreMember<[sourceId: string], JobSourceState | null> = async (brain, sourceId) => {
  const row: JobSourceState | null = await call('readJobSourceState', () => brain.readJobSourceState(sourceId));
  return row ? withDates(row, ['created_at']) : null;
};

export const listJobPage: StoreMember<[spec: JobPageSpec], JobRow[]> = async (brain, spec) =>
  jobRows(await call('listJobPage', () => brain.listJobPage({ ...spec, cursor: spec.cursor ?? null })));

// ---------------------------------------------------------------- attachments

export const listJobAttachmentNames: StoreMember<[jobId: number], string[] | null> = (brain, jobId) =>
  call('listJobAttachmentNames', () => brain.listJobAttachmentNames(jobId));

export const insertJobAttachment: StoreMember<[jobId: number, attachment: JobAttachmentInsert], JobRow> = async (brain, jobId, a) =>
  attachmentRow(await call('insertJobAttachment', () => brain.insertJobAttachment(jobId, {
    filename: a.filename, content_type: a.content_type, content_b64: Buffer.from(a.bytes).toString('base64'), size_bytes: a.size_bytes, sha256: a.sha256,
  })));

export const listJobAttachments: StoreMember<[jobId: number], JobRow[]> = async (brain, jobId) =>
  (await call('listJobAttachments', () => brain.listJobAttachments(jobId)) as JobRow[]).map(attachmentRow);

export const getJobAttachment: StoreMember<[jobId: number, filename: string], JobRow | null> = async (brain, jobId, filename) => {
  const row: JobRow | null = await call('getJobAttachment', () => brain.getJobAttachment(jobId, filename));
  return row ? attachmentRow(row) : null;
};

export const deleteJobAttachment: StoreMember<[jobId: number, filename: string], boolean> = (brain, jobId, filename) =>
  call('deleteJobAttachment', () => brain.deleteJobAttachment(jobId, filename));
