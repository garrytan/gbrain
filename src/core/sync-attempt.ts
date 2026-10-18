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
}

const JOB_SQL = `SELECT id AS job_id, status, result->>'status' AS result_status, result->>'failedFiles' AS failed_files,
    COALESCE(finished_at, started_at, created_at) AS at
  FROM minion_jobs WHERE name='sync'
    AND (COALESCE(data->>'sourceId', data->>'source_id')=$1 OR (COALESCE(data->>'sourceId', data->>'source_id') IS NULL
      AND (data->>'repoPath' IS NULL AND $1='default' OR data->>'repoPath'=(SELECT local_path FROM sources WHERE id=$1))))
  ORDER BY created_at DESC, id DESC LIMIT 1`;

const iso = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};

async function lastSyncJob(engine: BrainEngine, sourceId: string): Promise<Omit<SyncAttempt, 'managed_next'> | null> {
  let rows: Array<{ job_id: number | string | null; status: string | null; result_status: string | null; failed_files: string | null; at: unknown }>;
  try {
    rows = await engine.executeRaw(JOB_SQL, [sourceId]);
  } catch (error) {
    if (isMissingSchemaObject(error, 'table', 'minion_jobs')) return null;
    throw error;
  }
  const row = rows?.[0];
  if (!row || row.job_id === null || row.job_id === undefined || typeof row.status !== 'string') return null;
  const queued = ['waiting', 'delayed', 'active', 'waiting-children', 'paused'].includes(row.status);
  const failed = Number(row.failed_files ?? 0);
  return {
    state: queued ? 'attempt_queued' : 'last_attempt_unsuccessful',
    last_attempt_at: iso(row.at),
    result: row.result_status ? `${row.status} (${row.result_status})` : row.status,
    held: Number.isFinite(failed) ? failed : 0,
    job_id: Number(row.job_id),
  };
}

export async function readLastSyncAttempt(engine: BrainEngine, sourceId: string, managed: boolean): Promise<SyncAttempt> {
  const none: SyncAttempt = { state: 'no_attempt', last_attempt_at: null, result: null, held: 0, job_id: null, managed_next: null };
  try {
    const job = await lastSyncJob(engine, sourceId);
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
    };
  } catch (error) {
    return { ...none, unreadable: error instanceof Error ? error.message : String(error) };
  }
}
