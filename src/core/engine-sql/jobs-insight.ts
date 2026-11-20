/**
 * The reads behind `describeJobs` (minions/job-insight.ts): who submitted each job, how many waiting jobs are ahead of
 * it, which jobs hold the active slots of its queue, which live children a parent waits for, which live drain-lease
 * or sync lock a waiting job is blocked by, and the tokens of completed children another principal owns. SQL once for
 * both engines, so a store that is not SQL serves the same member (rust/docs/store/jobs-insight.md).
 *
 * One member answers all six reads, as `describeJobs` runs them together; each part is skipped when its input list is
 * empty. Every statement keeps the text `describeJobs` ran, byte for byte (scripts/sql-move-check.mjs holds it to that),
 * so a row comes back as the driver returns it (counts and sums may be strings, timestamps the driver's own type) and
 * `describeJobs` converts as it did. The clock and the spend tree stay in `describeJobs`.
 */
import type { BrainEngine } from '../engine.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

/** The most active jobs listed as slot holders across the waiting queues (the `LIMIT` of the holders read). */
export const HOLDER_LIMIT = 500;

/** What `readJobInsight` reads for one batch of described jobs. */
export interface JobInsightSpec {
  /** Every described job. */
  jobIds: readonly number[];
  /** The described jobs that are `waiting`: their queue position is counted. */
  waitingIds: readonly number[];
  /** The distinct queues of the waiting jobs: their active holders are listed. */
  waitingQueues: readonly string[];
  /** The described jobs that are `waiting-children`: their live children are listed. */
  parentIds: readonly number[];
  /** The `gbrain_cycle_locks` ids a waiting or delayed job would take when it runs. */
  lockIds: readonly string[];
  /** The queue of drain-lease beacon rows: never listed as a slot holder, and the lock beacon is read from it. */
  holderQueue: string;
  /** An owner-fenced caller's client id; the tokens of other owners' completed children are summed only when set. */
  owner: string | null;
}

export interface JobInsightRows {
  /** One row per described job that exists: its application submitter label and its parent's owner (no stated order). */
  meta: Array<{ id: number; submitter: string | null; parent_owner: string | null }>;
  /** Waiting jobs of the same queue ordered before the job (priority, then age, then id), no stated row order. */
  ahead: Array<{ id: number; ahead: number | string }>;
  /** Active jobs of the waiting queues (never the holder queue), oldest start first, nulls last, then id, at most `HOLDER_LIMIT`. */
  holders: Array<{ id: number; name: string; queue: string; owner: string | null }>;
  /** The children of the parents that are not finished, by id. */
  children: Array<{ id: number; parent_job_id: number; owner: string | null }>;
  /** Live (unexpired) leases among `lockIds`, with the beacon job's record and the job that beacon names (no stated order). */
  locks: Array<{
    id: string; holder_pid: number; holder_host: string | null; acquired_at: unknown; ttl_expires_at: unknown;
    beacon: unknown; holder_owner: string | null;
  }>;
  /** Per parent: the tokens of its completed children that another owner (or none) submitted (no stated order). */
  foreign_tokens: Array<{ parent_job_id: number; i: number | string; o: number | string; c: number | string }>;
}

export async function readJobInsight(tx: Raw, spec: JobInsightSpec): Promise<JobInsightRows> {
  const out: JobInsightRows = { meta: [], ahead: [], holders: [], children: [], locks: [], foreign_tokens: [] };
  if (spec.jobIds.length > 0) {
    out.meta = await tx.executeRaw<{ id: number; submitter: string | null; parent_owner: string | null }>(
      `SELECT j.id, CASE WHEN j.submission_authority->>'kind' = 'application' THEN j.data->>'__submitter' END AS submitter,
            p.data->>'__owner_client_id' AS parent_owner
       FROM minion_jobs j LEFT JOIN minion_jobs p ON p.id = j.parent_job_id
      WHERE j.id = ANY($1::int[])`, [spec.jobIds]);
  }
  if (spec.waitingIds.length > 0) {
    out.ahead = await tx.executeRaw<{ id: number; ahead: number | string }>(
      `SELECT j.id, (SELECT count(*) FROM minion_jobs w
                      WHERE w.queue = j.queue AND w.status = 'waiting'
                        AND (w.priority, w.created_at, w.id) < (j.priority, j.created_at, j.id)) AS ahead
         FROM minion_jobs j WHERE j.id = ANY($1::int[])`, [spec.waitingIds]);
    out.holders = await tx.executeRaw<{ id: number; name: string; queue: string; owner: string | null }>(
      `SELECT id, name, queue, data->>'__owner_client_id' AS owner FROM minion_jobs
        WHERE status = 'active' AND queue = ANY($1::text[]) AND queue <> $2 ORDER BY started_at ASC NULLS LAST, id ASC LIMIT 500`,
      [spec.waitingQueues, spec.holderQueue]);
  }
  if (spec.parentIds.length > 0) {
    out.children = await tx.executeRaw<{ id: number; parent_job_id: number; owner: string | null }>(
      `SELECT id, parent_job_id, data->>'__owner_client_id' AS owner FROM minion_jobs
        WHERE parent_job_id = ANY($1::int[]) AND status NOT IN ('completed','failed','dead','cancelled') ORDER BY id ASC`,
      [spec.parentIds]);
  }
  if (spec.lockIds.length > 0) {
    out.locks = await tx.executeRaw<JobInsightRows['locks'][number]>(
      `SELECT l.id, l.holder_pid, l.holder_host, l.acquired_at, l.ttl_expires_at, b.data->'drain_lease_beacon' AS beacon,
              h.data->>'__owner_client_id' AS holder_owner
         FROM gbrain_cycle_locks l
         LEFT JOIN minion_jobs b ON b.queue = $2 AND b.lock_token = l.acquisition_token::text
         LEFT JOIN minion_jobs h ON (b.data->'drain_lease_beacon'->>'kind') = 'job'
                                AND h.id::text = (b.data->'drain_lease_beacon'->>'id')
        WHERE l.id = ANY($1::text[]) AND l.ttl_expires_at > now()`, [spec.lockIds, spec.holderQueue]);
  }
  if (spec.owner !== null && spec.jobIds.length > 0) {
    out.foreign_tokens = await tx.executeRaw<{ parent_job_id: number; i: number | string; o: number | string; c: number | string }>(
      `SELECT parent_job_id, sum(tokens_input) AS i, sum(tokens_output) AS o, sum(tokens_cache_read) AS c FROM minion_jobs
        WHERE parent_job_id = ANY($1::int[]) AND status = 'completed' AND data->>'__owner_client_id' IS DISTINCT FROM $2::text
        GROUP BY 1`, [spec.jobIds, spec.owner]);
  }
  return out;
}
