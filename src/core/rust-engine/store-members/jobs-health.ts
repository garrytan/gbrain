/**
 * Queue health reads (engine-sql/jobs-health.ts): what doctor's queue checks, the advisor's stalled-jobs collector and the
 * submit-time queue probe ask of `minion_jobs`. The store answers each from its job rows (rust/docs/store/jobs-health.md)
 * with counts as numbers; only the two completion times of `readWedgeSignals` cross as ISO text and come back as `Date`s.
 */
import type {
  PrivateQueueHealthRow, QueueDivergence, QueueDivergenceSpec, QueueHealthSignals, QueueHealthSpec, QueueWedgeRow, QueueWedgeSignals, WaitingByQueueRow,
} from '../../engine-sql/jobs-health.ts';
import { withDates } from '../store-codec.ts';
import { storeCall, type StoreMember } from './common.ts';

const call = <T>(member: string, run: () => Promise<T>): Promise<T> => storeCall({ member }, run);

export const readQueueHealthSignals: StoreMember<[spec: QueueHealthSpec], QueueHealthSignals> = (brain, spec) =>
  call('readQueueHealthSignals', () => brain.readQueueHealthSignals(spec));

export const listWaitingByQueue: StoreMember<[], WaitingByQueueRow[]> = (brain) => call('listWaitingByQueue', () => brain.listWaitingByQueue());

export const readQueueDivergence: StoreMember<[spec: QueueDivergenceSpec], QueueDivergence> = (brain, spec) =>
  call('readQueueDivergence', () => brain.readQueueDivergence(spec));

export const listQueueWedgeCounts: StoreMember<[], QueueWedgeRow[]> = (brain) => call('listQueueWedgeCounts', () => brain.listQueueWedgeCounts());

export const listPrivateQueueHealth: StoreMember<[], PrivateQueueHealthRow[]> = (brain) => call('listPrivateQueueHealth', () => brain.listPrivateQueueHealth());

/**
 * `opts.signal` is not forwarded: a store call is one in-process read that cannot be cancelled part way, and the
 * probe's own timeout still bounds how long its caller waits for it.
 */
export const readWedgeSignals: StoreMember<[queue: string, handlerNames: readonly string[], opts?: { signal?: AbortSignal }], QueueWedgeSignals> =
  async (brain, queue, handlerNames) =>
    withDates(await call('readWedgeSignals', () => brain.readWedgeSignals(queue, [...handlerNames])), ['lastCompleted', 'lastCompletedClaimable'] as const);

export const readOldestWaitingAge: StoreMember<[queue: string, opts?: { signal?: AbortSignal }], number | null> =
  (brain, queue) => call('readOldestWaitingAge', () => brain.readOldestWaitingAge(queue));

export const listStuckActiveJobsByName: StoreMember<[], Array<{ name: string; n: number }>> =
  (brain) => call('listStuckActiveJobsByName', () => brain.listStuckActiveJobsByName());
