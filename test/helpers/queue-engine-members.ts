/**
 * The queue-health engine members (engine-sql/jobs-health.ts) for a hand-built fake engine.
 *
 * Hermetic doctor and supervisor tests script a fake `executeRaw`. Since the queue-health statements moved into engine
 * members, the checks call `engine.readQueueHealthSignals()`, `engine.readWedgeSignals()` and the rest; this adds each
 * member the fake does not define, running the shared statement on the fake itself, as PGLite and Postgres do. The
 * status reads (engine-sql/jobs-status.ts) are added the same way.
 */
import * as jobsHealth from '../../src/core/engine-sql/jobs-health.ts';
import * as jobsStatus from '../../src/core/engine-sql/jobs-status.ts';

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

/** `fake` with every queue-health member it lacks, each running the shared statement on `fake`. */
export function withQueueMembers<T extends object>(fake: T): T {
  const target = fake as Record<string, unknown>;
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
  return fake;
}
