/**
 * The queue-health engine members (engine-sql/jobs-health.ts) for a hand-built fake engine.
 *
 * Hermetic doctor and supervisor tests script a fake `executeRaw`. Since the queue-health statements moved into engine
 * members, the checks call `engine.readQueueHealthSignals()`, `engine.readWedgeSignals()` and the rest; this adds each
 * member the fake does not define, running the shared statement on the fake itself, as PGLite and Postgres do.
 */
import * as jobsHealth from '../../src/core/engine-sql/jobs-health.ts';

const HEALTH_MEMBERS = [
  'readQueueHealthSignals', 'listWaitingByQueue', 'readQueueDivergence', 'listQueueWedgeCounts', 'listPrivateQueueHealth',
  'readWedgeSignals', 'readOldestWaitingAge', 'listStuckActiveJobsByName',
] as const satisfies ReadonlyArray<keyof typeof jobsHealth>;

/** `fake` with every queue-health member it lacks, each running the shared statement on `fake`. */
export function withQueueMembers<T extends object>(fake: T): T {
  const target = fake as Record<string, unknown>;
  for (const name of HEALTH_MEMBERS) {
    if (name in target) continue;
    const member = jobsHealth[name] as (tx: unknown, ...args: unknown[]) => unknown;
    target[name] = (...args: unknown[]) => member(fake, ...args);
  }
  return fake;
}
