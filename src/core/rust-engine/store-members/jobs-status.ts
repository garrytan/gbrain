/**
 * The minion status reads (engine-sql/jobs-status.ts): the counts and last-run reads behind `gbrain status`, `jobs stats`,
 * the facts drain backlog, source health and the sync status report. The store answers from the job rows and the clock it
 * holds (rust/docs/store/jobs-status.md); timestamps cross the binding as ISO strings and come back as `Date`s.
 */
import type {
  BudgetOwnerRow, EmbedBackfillState, FailedJobError, JobStatusCount, JobStatusFilter, LastAutopilotCycles, QueueDepth, SourceJobCounts,
  SourceCycleFailureRow, TtlCancelledCount, WaitingScopeState,
} from '../../engine-sql/jobs-status.ts';
import { withDates } from '../store-codec.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';

const call = <T>(member: string, run: () => Promise<T>): Promise<T> => storeCall({ member }, run);

export const readLastAutopilotCycles: StoreMember<[], LastAutopilotCycles> = async (brain) => {
  const out: LastAutopilotCycles = await call('readLastAutopilotCycles', () => brain.readLastAutopilotCycles());
  const revive = <T extends { finished_at: Date | null; started_at: Date | null }>(row: T | null): T | null =>
    (row ? withDates(row, ['finished_at', 'started_at']) : null);
  return { full: revive(out.full), targeted: revive(out.targeted) };
};

export const countJobsByStatus: StoreMember<[filter?: JobStatusFilter], JobStatusCount[]> = (brain, filter) =>
  call('countJobsByStatus', () => brain.countJobsByStatus(filter
    ? { name: filter.name ?? null, queue: filter.queue ?? null, statuses: filter.statuses ? [...filter.statuses] : null }
    : null));

export const readWaitingQueueDepths: StoreMember<[], QueueDepth[]> = (brain) => call('readWaitingQueueDepths', () => brain.readWaitingQueueDepths());

export const readLastCompletedJobAt: StoreMember<[], Date | null> = async (brain) => {
  const at: string | null = await call('readLastCompletedJobAt', () => brain.readLastCompletedJobAt());
  return at === null ? null : new Date(at);
};

export const listRecentSourceCycleFailures: StoreMember<[spec: { cutoff: string; sourceId?: string | null }], SourceCycleFailureRow[]> = async (brain, spec) => {
  const rows: SourceCycleFailureRow[] = await call('listRecentSourceCycleFailures', () => brain.listRecentSourceCycleFailures(spec.cutoff, spec.sourceId || null));
  return rows.map((row) => withDates(row, ['last_failed_at']));
};

export const countTtlCancelledByName: StoreMember<[reasonLike: string, withinSeconds: number], TtlCancelledCount[]> = (brain, reasonLike, withinSeconds) =>
  call('countTtlCancelledByName', () => brain.countTtlCancelledByName(reasonLike, withinSeconds));

export const readWaitingScopeState: StoreMember<[spec: { name: string; queue: string; jobId: number }], WaitingScopeState> = (brain, spec) =>
  call('readWaitingScopeState', () => brain.readWaitingScopeState({ name: spec.name, queue: spec.queue, jobId: spec.jobId }));

export const countRecentCompletedJobs: StoreMember<[name: string, withinSeconds: number], number> = (brain, name, withinSeconds) =>
  call('countRecentCompletedJobs', () => brain.countRecentCompletedJobs(name, withinSeconds));

export const listRecentFailedJobErrors: StoreMember<[withinSeconds: number], FailedJobError[]> = (brain, withinSeconds) =>
  call('listRecentFailedJobErrors', () => brain.listRecentFailedJobErrors(withinSeconds));

/** [] when no unfinished job owns a budget; otherwise refused: the spend total reads a budget log this store does not keep. */
export const listBudgetOwners: StoreMember<[], BudgetOwnerRow[]> = async (brain) => {
  const owners = await call('listBudgetOwners', () => brain.listBudgetOwnerJobs()) as unknown[];
  if (owners.length === 0) return [];
  return refuseMember('listBudgetOwners', 'the spend log of a budget owner');
};

export const readQueuedPageChars: StoreMember<[spec: { name: string; queue: string; maxChars: number }], number | null> = (brain, spec) =>
  call('readQueuedPageChars', () => brain.readQueuedPageChars({ name: spec.name, queue: spec.queue, maxChars: spec.maxChars }));

export const readSourceJobCounts: StoreMember<[failedWithinSeconds: number], SourceJobCounts[]> = (brain, failedWithinSeconds) =>
  call('readSourceJobCounts', () => brain.readSourceJobCounts(failedWithinSeconds));

export const readEmbedBackfillBySource: StoreMember<[sourceIds: readonly string[]], EmbedBackfillState[]> = async (brain, sourceIds) => {
  const rows: EmbedBackfillState[] = await call('readEmbedBackfillBySource', () => brain.readEmbedBackfillBySource([...sourceIds]));
  return rows.map(r => withDates(r, ['last_completed_at']));
};
