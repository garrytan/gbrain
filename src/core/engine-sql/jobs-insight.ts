/**
 * The reads behind `describeJobs` (minions/job-insight.ts): who submitted each job, how many waiting jobs are ahead of
 * it, which jobs hold the active slots of its queue, which live children a parent waits for, which live drain-lease
 * or sync lock a waiting job is blocked by, and the tokens of completed children another principal owns. SQL once for
 * both engines, so a store that is not SQL serves the same member (rust/docs/store/jobs-insight.md).
 *
 * One member answers all six reads, as `describeJobs` runs them together; each part is skipped when its input list is
 * empty. The spend tree (`mcp_spend_reservations`) is not here: the Rust store keeps no spend rows, so `describeJobs`
 * still reads it through `executeRaw`.
 *
 * Every function takes the transaction (or the engine, for a single statement) it runs on. Rows come back typed:
 * counts and sums as numbers, timestamps as `Date`s.
 */
import type { BrainEngine } from '../engine.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

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
  /** At most this many active holders, across the waiting queues. */
  holderLimit: number;
  /** An owner-fenced caller's client id; the tokens of other owners' completed children are summed only when set. */
  owner: string | null;
}

export interface JobInsightRows {
  /** One row per described job that exists: its application submitter label and its parent's owner. */
  meta: Array<{ id: number; submitter: string | null; parent_owner: string | null }>;
  /** Waiting jobs of the same queue ordered before the job (priority, then age, then id). */
  ahead: Array<{ id: number; ahead: number }>;
  /** Active jobs of the waiting queues (never the holder queue), oldest start first, nulls last, then id. */
  holders: Array<{ id: number; name: string; queue: string; owner: string | null }>;
  /** The children of the parents that are not finished, by id. */
  children: Array<{ id: number; parent_job_id: number; owner: string | null }>;
  /** Live (unexpired) leases among `lockIds`, with the beacon job's record and the job that beacon names. */
  locks: Array<{
    id: string; holder_pid: number; holder_host: string | null; acquired_at: Date; ttl_expires_at: Date;
    beacon: unknown; holder_owner: string | null;
  }>;
  /** Per parent: the tokens of its completed children that another owner (or none) submitted. */
  foreign_tokens: Array<{ parent_job_id: number; i: number; o: number; c: number }>;
}

const num = (v: unknown): number => (v == null ? 0 : Number(v));

export async function readJobInsight(tx: Raw, spec: JobInsightSpec): Promise<JobInsightRows> {
  const out: JobInsightRows = { meta: [], ahead: [], holders: [], children: [], locks: [], foreign_tokens: [] };
  if (spec.jobIds.length > 0) {
    const rows = await tx.executeRaw<{ id: number; submitter: string | null; parent_owner: string | null }>(
      `SELECT j.id, CASE WHEN j.submission_authority->>'kind' = 'application' THEN j.data->>'__submitter' END AS submitter,
              p.data->>'__owner_client_id' AS parent_owner
         FROM minion_jobs j LEFT JOIN minion_jobs p ON p.id = j.parent_job_id
        WHERE j.id = ANY($1::int[]) ORDER BY j.id`, [spec.jobIds]);
    out.meta = rows.map(r => ({ id: Number(r.id), submitter: r.submitter, parent_owner: r.parent_owner }));
  }
  if (spec.waitingIds.length > 0) {
    const ahead = await tx.executeRaw<{ id: number; ahead: number | string }>(
      `SELECT j.id, (SELECT count(*) FROM minion_jobs w
                      WHERE w.queue = j.queue AND w.status = 'waiting'
                        AND (w.priority, w.created_at, w.id) < (j.priority, j.created_at, j.id)) AS ahead
         FROM minion_jobs j WHERE j.id = ANY($1::int[]) ORDER BY j.id`, [spec.waitingIds]);
    out.ahead = ahead.map(r => ({ id: Number(r.id), ahead: num(r.ahead) }));
    const active = await tx.executeRaw<{ id: number; name: string; queue: string; owner: string | null }>(
      `SELECT id, name, queue, data->>'__owner_client_id' AS owner FROM minion_jobs
        WHERE status = 'active' AND queue = ANY($1::text[]) AND queue <> $2 ORDER BY started_at ASC NULLS LAST, id ASC LIMIT $3`,
      [spec.waitingQueues, spec.holderQueue, spec.holderLimit]);
    out.holders = active.map(r => ({ id: Number(r.id), name: r.name, queue: r.queue, owner: r.owner }));
  }
  if (spec.parentIds.length > 0) {
    const rows = await tx.executeRaw<{ id: number; parent_job_id: number; owner: string | null }>(
      `SELECT id, parent_job_id, data->>'__owner_client_id' AS owner FROM minion_jobs
        WHERE parent_job_id = ANY($1::int[]) AND status NOT IN ('completed','failed','dead','cancelled') ORDER BY id ASC`,
      [spec.parentIds]);
    out.children = rows.map(r => ({ id: Number(r.id), parent_job_id: Number(r.parent_job_id), owner: r.owner }));
  }
  if (spec.lockIds.length > 0) {
    const rows = await tx.executeRaw<{
      id: string; holder_pid: number | string; holder_host: string | null; acquired_at: Date | string;
      ttl_expires_at: Date | string; beacon: unknown; holder_owner: string | null;
    }>(
      `SELECT l.id, l.holder_pid, l.holder_host, l.acquired_at, l.ttl_expires_at, b.data->'drain_lease_beacon' AS beacon,
              h.data->>'__owner_client_id' AS holder_owner
         FROM gbrain_cycle_locks l
         LEFT JOIN minion_jobs b ON b.queue = $2 AND b.lock_token = l.acquisition_token::text
         LEFT JOIN minion_jobs h ON (b.data->'drain_lease_beacon'->>'kind') = 'job'
                                AND h.id::text = (b.data->'drain_lease_beacon'->>'id')
        WHERE l.id = ANY($1::text[]) AND l.ttl_expires_at > now() ORDER BY l.id`, [spec.lockIds, spec.holderQueue]);
    out.locks = rows.map(r => ({
      id: r.id, holder_pid: Number(r.holder_pid), holder_host: r.holder_host, acquired_at: new Date(r.acquired_at),
      ttl_expires_at: new Date(r.ttl_expires_at), beacon: r.beacon ?? null, holder_owner: r.holder_owner,
    }));
  }
  if (spec.owner !== null && spec.jobIds.length > 0) {
    const rows = await tx.executeRaw<{ parent_job_id: number; i: number | string; o: number | string; c: number | string }>(
      `SELECT parent_job_id, sum(tokens_input) AS i, sum(tokens_output) AS o, sum(tokens_cache_read) AS c FROM minion_jobs
        WHERE parent_job_id = ANY($1::int[]) AND status = 'completed' AND data->>'__owner_client_id' IS DISTINCT FROM $2::text
        GROUP BY 1 ORDER BY 1`, [spec.jobIds, spec.owner]);
    out.foreign_tokens = rows.map(r => ({ parent_job_id: Number(r.parent_job_id), i: num(r.i), o: num(r.o), c: num(r.c) }));
  }
  return out;
}
