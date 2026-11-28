/**
 * The queue reads the doctor checks and the dream breaker make (engine-sql/jobs-checks.ts): stalled embed-backfill
 * sources, how the brain-wide maintenance job and its dream children died, facts-absorb jobs that are still dead,
 * legacy submission authority, queued spend, build-skew stacktrace lines, dead dream submissions and the dead-write
 * retry's facts-absorb rows. The store keeps the rows (rust/docs/store/jobs-checks.md); the rows it returns carry
 * `finished_at` as ISO text, which these members turn into the `Date`s PGLite returns.
 */
import type {
  DeadDreamSubmissionSpec, FactsAbsorbJobRow, FactsAbsorbStillDead, GlobalMaintenanceDeaths, LastFailedGlobalMaintenanceJob,
  LastSyncJobRow, LegacyJobAuthorityRead, QueuedSpendRows,
} from '../../engine-sql/jobs-checks.ts';
import { withDates } from '../store-codec.ts';
import { storeCall, type StoreMember } from './common.ts';

const call = <T>(member: string, run: () => Promise<T>): Promise<T> => storeCall({ member }, run);

const factsAbsorbRows = (rows: FactsAbsorbJobRow[]): FactsAbsorbJobRow[] => rows.map(r => withDates(r, ['finished_at'] as const));

export const listStalledEmbedBackfillSources: StoreMember<[], Array<string | null>> = brain =>
  call('listStalledEmbedBackfillSources', () => brain.listStalledEmbedBackfillSources());

export const readGlobalMaintenanceDeaths: StoreMember<[spec: { deaths: number }], GlobalMaintenanceDeaths> = (brain, spec) =>
  call('readGlobalMaintenanceDeaths', () => brain.readGlobalMaintenanceDeaths(spec));

export const readLastFailedGlobalMaintenanceJob: StoreMember<[since: string | null], LastFailedGlobalMaintenanceJob | null> = (brain, since) =>
  call('readLastFailedGlobalMaintenanceJob', () => brain.readLastFailedGlobalMaintenanceJob(since));

export const listFactsAbsorbJobsStillDead: StoreMember<[spec: { hours: number; limit: number }], FactsAbsorbStillDead> = (brain, spec) =>
  call('listFactsAbsorbJobsStillDead', () => brain.listFactsAbsorbJobsStillDead(spec));

export const readLegacyJobAuthority: StoreMember<[], LegacyJobAuthorityRead> = brain =>
  call('readLegacyJobAuthority', () => brain.readLegacyJobAuthority());

export const readQueuedSpendRows: StoreMember<[spec: { legacyPrefixes: Readonly<Record<string, readonly string[]>>; waitMs: number }], QueuedSpendRows> = (brain, spec) =>
  call('readQueuedSpendRows', () => brain.readQueuedSpendRows(spec));

export const listBuildSkewStacktraceLines: StoreMember<[spec: { prefix: string; windowHours: number; scanJobs: number }], Array<{ id: number; line: string }>> = (brain, spec) =>
  call('listBuildSkewStacktraceLines', () => brain.listBuildSkewStacktraceLines(spec));

/**
 * A reset time crosses as the ISO text `Date#toISOString` gives (the store reads that one form; the dream breaker's
 * reset file already holds it), so a time written another way is normalized here first.
 */
export const countDeadDreamSubmissionRows: StoreMember<[spec: DeadDreamSubmissionSpec], Array<{ base_key: string; dead_submissions: number; last_dead_at: string }>> = (brain, spec) => {
  const resets = Object.fromEntries(Object.entries(spec.resets).map(([key, at]) => {
    const ms = Date.parse(at);
    return [key, Number.isFinite(ms) ? new Date(ms).toISOString() : at];
  }));
  return call('countDeadDreamSubmissionRows', () => brain.countDeadDreamSubmissionRows({ ...spec, resets }));
};

export const listFactsAbsorbJobsByKeyPrefix: StoreMember<[spec: { prefix: string; keys: readonly string[] }], FactsAbsorbJobRow[]> = async (brain, spec) =>
  factsAbsorbRows(await call('listFactsAbsorbJobsByKeyPrefix', () => brain.listFactsAbsorbJobsByKeyPrefix(spec)));

export const listDeadFactsAbsorbJobsByKeys: StoreMember<[keys: readonly string[]], FactsAbsorbJobRow[]> = async (brain, keys) =>
  factsAbsorbRows(await call('listDeadFactsAbsorbJobsByKeys', () => brain.listDeadFactsAbsorbJobsByKeys(keys)));

/** The store returns the three times as ISO text; PGLite returns `Date`s. */
export const readLastSyncJob: StoreMember<[sourceId: string, freshSince: string | null], LastSyncJobRow | null> = async (brain, sourceId, freshSince) => {
  const row: LastSyncJobRow | null = await call('readLastSyncJob', () => brain.readLastSyncJob(sourceId, freshSince));
  return row ? withDates(row, ['started_at', 'at', 'usage_limited_since'] as const) : null;
};
