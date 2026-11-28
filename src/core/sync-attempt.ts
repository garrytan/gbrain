/**
 * The last sync attempt of a source that has no successful sync recorded
 * (`sources.last_sync_at` NULL), for doctor `sync_freshness` (#4960). Read-only:
 * a managed brain reads `readSyncStatus` (holds, the last error, the cursor and
 * its own `next`); any brain reads the newest `sync` Minions job of the source.
 * Nothing found is "no attempt recorded", never a guess.
 */
import type { Action } from './agent-output.ts';
import type { BrainEngine } from './engine.ts';
import { isMissingSchemaObject } from './utils.ts';

export type SyncAttemptState = 'no_attempt' | 'attempt_queued' | 'holds_pending' | 'last_attempt_unsuccessful';

export interface SyncAttempt {
  state: SyncAttemptState;
  /** When the attempt last ran (job finish/start/enqueue, or the managed failure or cursor advance), ISO. */
  last_attempt_at: string | null;
  /** Job status (`failed`, `completed`, …) plus its sync result (`partial`, …), or the managed last error code. */
  result: string | null;
  /** Files held by the managed sync (or the failed-file count of the job's result). */
  held: number;
  job_id: number | null;
  /** The source's managed `readSyncStatus.next`, when it names one. */
  managed_next: Action | null;
  /** Why the attempt could not be read; the state is then `no_attempt`. */
  unreadable?: string;
  /** GST-3452: the newest sync job is running now (active, its job lock not expired). */
  live_job?: true;
  /** GST-3452: when that running job started, ISO. */
  live_job_started_at?: string;
  /**
   * GST-3452: the newest run inside the fail age that stopped only at a provider usage or rate limit (`stopped_on: usage_limit`,
   * no writes pending) and landed pages, when every later run that finished also only hit the limit (queued, running,
   * skipped and limited runs with writes pending pass); ISO.
   */
  usage_limited_since?: string;
}

const iso = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};

async function lastSyncJob(engine: BrainEngine, sourceId: string, freshSince: string | null): Promise<Omit<SyncAttempt, 'managed_next'> | null> {
  let row: Awaited<ReturnType<BrainEngine['readLastSyncJob']>>;
  try {
    row = await engine.readLastSyncJob(sourceId, freshSince);
  } catch (error) {
    if (isMissingSchemaObject(error, 'table', 'minion_jobs')) return null;
    throw error;
  }
  if (!row) return null;
  const queued = ['waiting', 'delayed', 'active', 'waiting-children', 'paused'].includes(row.status) && !(row.status === 'active' && row.live !== true);
  const failed = Number(row.failed_files ?? 0);
  const since = iso(row.usage_limited_since);
  const started = row.live === true ? iso(row.started_at) : null;
  const causes = Array.isArray(row.partial_causes) ? row.partial_causes.filter((c): c is string => typeof c === 'string') : [];
  const outcome = causes.length ? row.result_status + ': ' + causes.join('; ') : row.result_status;
  return {
    state: queued ? 'attempt_queued' : 'last_attempt_unsuccessful',
    last_attempt_at: iso(row.at),
    result: row.result_status ? `${row.status} (${outcome})` : row.status,
    held: Number.isFinite(failed) ? failed : 0,
    job_id: Number(row.job_id),
    ...(row.live === true ? { live_job: true as const, ...(started ? { live_job_started_at: started } : {}) } : {}),
    ...(since ? { usage_limited_since: since } : {}),
  };
}

/** `freshSinceMs`: sync_freshness's fail age; without it no usage-limited run is read. */
export async function readLastSyncAttempt(engine: BrainEngine, sourceId: string, managed: boolean, freshSinceMs?: number): Promise<SyncAttempt> {
  const none: SyncAttempt = { state: 'no_attempt', last_attempt_at: null, result: null, held: 0, job_id: null, managed_next: null };
  try {
    const job = await lastSyncJob(engine, sourceId, freshSinceMs === undefined ? null : new Date(freshSinceMs).toISOString());
    if (!managed) return job ? { ...job, managed_next: null } : none;
    const { readSyncStatus } = await import('./persistence/sync-status.ts');
    const status = await readSyncStatus(engine, sourceId);
    const held = status.holds.length;
    const lastAt = status.last_error?.first_seen ?? status.cursor?.last_advance_at ?? null;
    const managedResult = status.last_error?.code ?? (status.cursor && !status.cursor.done ? `cursor at ${status.cursor.index}/${status.cursor.total}` : null);
    if (!job && !held && !lastAt && !managedResult) return { ...none, managed_next: status.next };
    const newerJob = job && (!lastAt || (job.last_attempt_at ?? '') > lastAt);
    return {
      state: held ? 'holds_pending' : job?.state === 'attempt_queued' ? 'attempt_queued' : 'last_attempt_unsuccessful',
      last_attempt_at: newerJob ? job!.last_attempt_at : iso(lastAt),
      result: newerJob ? job!.result : managedResult ?? job?.result ?? null,
      held: held || job?.held || 0,
      job_id: job?.job_id ?? null,
      managed_next: status.next,
      ...(job?.live_job ? { live_job: true as const, ...(job.live_job_started_at ? { live_job_started_at: job.live_job_started_at } : {}) } : {}),
      ...(newerJob && job!.usage_limited_since ? { usage_limited_since: job!.usage_limited_since } : {}),
    };
  } catch (error) {
    return { ...none, unreadable: error instanceof Error ? error.message : String(error) };
  }
}
