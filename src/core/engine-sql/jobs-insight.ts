/**
 * The reads behind `describeJobs` (minions/job-insight.ts): who submitted each job, how many waiting jobs are ahead of
 * it, which jobs hold the active slots of its queue, which live children a parent waits for, which live drain-lease
 * or sync lock a waiting job is blocked by, and the tokens of completed children another principal owns. SQL once for
 * both engines, so a store that is not SQL serves the same member (rust/docs/store/jobs-insight.md).
 *
 * One member answers all six reads, as `describeJobs` runs them together; each part is skipped when its input list is
 * empty. The spend tree (`mcp_spend_reservations`) is a separate member, `readJobSpendTree`
 * (engine-sql/jobs-spend.ts).
 *
 * Every function takes the transaction (or the engine, for a single statement) it runs on. Rows come back typed:
 * counts and sums as numbers, timestamps as `Date`s.
 */
import type { BrainEngine } from '../engine.ts';
import { renderFragment, sqlFragment, type SqlFragment } from './fragment.ts';
import { jobOwnedFragment, type JobAlias, type JobOwnerSpec } from './jobs-queue.ts';

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
  /**
   * An owner-fenced caller (GST-4010, `jobOwnedFragment`): each row reads back whether the caller owns it, and the tokens of
   * completed children it does not own are summed only when set. Null is unfenced: every row reads as owned.
   */
  owner: JobOwnerSpec | null;
}

export interface JobInsightRows {
  /** One row per described job that exists: its application submitter label, whether the caller owns it and whether it owns its parent. */
  meta: Array<{ id: number; submitter: string | null; owned: boolean; parent_owned: boolean }>;
  /** Waiting jobs of the same queue ordered before the job (priority, then age, then id). */
  ahead: Array<{ id: number; ahead: number }>;
  /** Active jobs of the waiting queues (never the holder queue), oldest start first, nulls last, then id. */
  holders: Array<{ id: number; name: string; queue: string; owned: boolean }>;
  /** The children of the parents that are not finished, by id. */
  children: Array<{ id: number; parent_job_id: number; owned: boolean }>;
  /** Live (unexpired) leases among `lockIds`, with the beacon job's record and the job that beacon names. */
  locks: Array<{
    id: string; holder_pid: number; holder_host: string | null; acquired_at: Date; ttl_expires_at: Date;
    beacon: unknown; holder_owned: boolean;
  }>;
  /** Per parent: the tokens of its completed descendants the caller does not own, reached through completed children it does own. */
  foreign_tokens: Array<{ parent_job_id: number; i: number; o: number; c: number }>;
}

const num = (v: unknown): number => (v == null ? 0 : Number(v));

/** The row behind `alias` is the fenced caller's; always true when unfenced. */
const ownedBy = (owner: JobOwnerSpec | null, alias: JobAlias): SqlFragment =>
  owner ? sqlFragment`COALESCE((${jobOwnedFragment(owner, alias)}), false)` : sqlFragment`true`;

export async function readJobInsight(tx: Raw, spec: JobInsightSpec): Promise<JobInsightRows> {
  const out: JobInsightRows = { meta: [], ahead: [], holders: [], children: [], locks: [], foreign_tokens: [] };
  const run = <T>(fragment: SqlFragment) => { const { text, params } = renderFragment(fragment); return tx.executeRaw<T>(text, params); };
  const { owner } = spec;
  if (spec.jobIds.length > 0) {
    const rows = await run<{ id: number; submitter: string | null; owned: boolean; parent_owned: boolean }>(
      sqlFragment`SELECT j.id, CASE WHEN j.submission_authority->>'kind' = 'application' THEN j.data->>'__submitter' END AS submitter,
              ${ownedBy(owner, 'j')} AS owned, ${ownedBy(owner, 'p')} AS parent_owned
         FROM minion_jobs j LEFT JOIN minion_jobs p ON p.id = j.parent_job_id
        WHERE j.id = ANY(${[...spec.jobIds]}::int[]) ORDER BY j.id`);
    out.meta = rows.map(r => ({ id: Number(r.id), submitter: r.submitter, owned: r.owned === true, parent_owned: r.parent_owned === true }));
  }
  if (spec.waitingIds.length > 0) {
    const ahead = await tx.executeRaw<{ id: number; ahead: number | string }>(
      `SELECT j.id, (SELECT count(*) FROM minion_jobs w
                      WHERE w.queue = j.queue AND w.status = 'waiting'
                        AND (w.priority, w.created_at, w.id) < (j.priority, j.created_at, j.id)) AS ahead
         FROM minion_jobs j WHERE j.id = ANY($1::int[]) ORDER BY j.id`, [spec.waitingIds]);
    out.ahead = ahead.map(r => ({ id: Number(r.id), ahead: num(r.ahead) }));
    const active = await run<{ id: number; name: string; queue: string; owned: boolean }>(
      sqlFragment`SELECT a.id, a.name, a.queue, ${ownedBy(owner, 'a')} AS owned FROM minion_jobs a
        WHERE a.status = 'active' AND a.queue = ANY(${[...spec.waitingQueues]}::text[]) AND a.queue <> ${spec.holderQueue}
        ORDER BY a.started_at ASC NULLS LAST, a.id ASC LIMIT ${spec.holderLimit}`);
    out.holders = active.map(r => ({ id: Number(r.id), name: r.name, queue: r.queue, owned: r.owned === true }));
  }
  if (spec.parentIds.length > 0) {
    const rows = await run<{ id: number; parent_job_id: number; owned: boolean }>(
      sqlFragment`SELECT c.id, c.parent_job_id, ${ownedBy(owner, 'c')} AS owned FROM minion_jobs c
        WHERE c.parent_job_id = ANY(${[...spec.parentIds]}::int[]) AND c.status NOT IN ('completed','failed','dead','cancelled') ORDER BY c.id ASC`);
    out.children = rows.map(r => ({ id: Number(r.id), parent_job_id: Number(r.parent_job_id), owned: r.owned === true }));
  }
  if (spec.lockIds.length > 0) {
    const rows = await run<{
      id: string; holder_pid: number | string; holder_host: string | null; acquired_at: Date | string;
      ttl_expires_at: Date | string; beacon: unknown; holder_owned: boolean;
    }>(
      sqlFragment`SELECT l.id, l.holder_pid, l.holder_host, l.acquired_at, l.ttl_expires_at, b.data->'drain_lease_beacon' AS beacon,
              ${ownedBy(owner, 'h')} AS holder_owned
         FROM gbrain_cycle_locks l
         LEFT JOIN minion_jobs b ON b.queue = ${spec.holderQueue} AND b.lock_token = l.acquisition_token::text
         LEFT JOIN minion_jobs h ON (b.data->'drain_lease_beacon'->>'kind') = 'job'
                                AND h.id::text = (b.data->'drain_lease_beacon'->>'id')
        WHERE l.id = ANY(${[...spec.lockIds]}::text[]) AND l.ttl_expires_at > now() ORDER BY l.id COLLATE "C"`);
    out.locks = rows.map(r => ({
      id: r.id, holder_pid: Number(r.holder_pid), holder_host: r.holder_host, acquired_at: new Date(r.acquired_at),
      ttl_expires_at: new Date(r.ttl_expires_at), beacon: r.beacon ?? null, holder_owned: r.holder_owned === true,
    }));
  }
  if (owner !== null && spec.jobIds.length > 0) {
    // The walk follows completed children the caller owns (to depth 20); a completed child of any of those it does not own is foreign.
    const rows = await run<{ parent_job_id: number; i: number | string; o: number | string; c: number | string }>(
      sqlFragment`WITH RECURSIVE walk(root, id, depth) AS (
         SELECT s.id, s.id, 0 FROM minion_jobs s WHERE s.id = ANY(${[...spec.jobIds]}::int[])
         UNION ALL
         SELECT w.root, k.id, w.depth + 1 FROM minion_jobs k JOIN walk w ON k.parent_job_id = w.id
          WHERE w.depth < 20 AND k.status = 'completed' AND ${ownedBy(owner, 'k')}
       )
       SELECT w.root AS parent_job_id, sum(c.tokens_input) AS i, sum(c.tokens_output) AS o, sum(c.tokens_cache_read) AS c
         FROM walk w JOIN minion_jobs c ON c.parent_job_id = w.id
        WHERE c.status = 'completed' AND NOT ${ownedBy(owner, 'c')}
        GROUP BY 1 ORDER BY 1`);
    out.foreign_tokens = rows.map(r => ({ parent_job_id: Number(r.parent_job_id), i: num(r.i), o: num(r.o), c: num(r.c) }));
  }
  return out;
}
