/**
 * Minion job counts and last-run reads for the status surfaces: `gbrain status` and its snapshot, `gbrain jobs stats`,
 * the facts drain backlog, the per-source health and sync-status report. Each is one aggregate over `minion_jobs`
 * (plus `pages` for the drain's cost estimate). SQL once for both engines.
 *
 * Every function takes the engine (or the transaction) it runs on. Time windows are seconds, so a caller's "24 hours"
 * is 86400 and a store with its own clock can serve the same window. Orders the callers left open carry a tiebreaker
 * so every engine lists ties the same way.
 */
import type { BrainEngine } from '../engine.ts';
import { renderFragment, sqlFragment } from './fragment.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

type Timestamp = Date | string;
const date = (v: Timestamp): Date => (v instanceof Date ? v : new Date(v));
const dateOrNull = (v: Timestamp | null | undefined): Date | null => (v == null ? null : date(v));

/** One finished autopilot run: the columns `gbrain status` reads (`result.report.totals` is the run's totals). */
export interface AutopilotCycleRow {
  finished_at: Date | null;
  name: string;
  status: string;
  started_at: Date | null;
  result: unknown;
}

/** The newest completed `autopilot-cycle` job and the newest completed `autopilot-*` job, or null for each. */
export interface LastAutopilotCycles { full: AutopilotCycleRow | null; targeted: AutopilotCycleRow | null }

/** `{ status, count }` per job status. */
export interface JobStatusCount { status: string; count: number }

/** Which jobs `countJobsByStatus` counts: a name, a queue and a set of statuses; an absent field matches everything. */
export interface JobStatusFilter { name?: string | null; queue?: string | null; statuses?: readonly string[] | null }

/** The waiting jobs of one queue: how many, and the age in whole seconds of the oldest. */
export interface QueueDepth { queue: string; depth: number; oldest_waiting_age_seconds: number | null }

/** Waiting-TTL cancellations of one job name. */
export interface TtlCancelledCount { name: string; count: number }

/**
 * What a returned (coalesced-onto) job's scope looks like now: the waiting jobs of its name and queue in the same
 * source scope, and, when the job itself is active with a live lease, its id and age in whole minutes.
 */
export interface WaitingScopeState { waiting: number; live_id: number | null; age_min: number | null }

/** A job read for its failure text. */
export interface FailedJobError { id: number; last_error: string | null }

/** Per-source job counts for the source health report (jobs of name `sync` and `embed-backfill`). */
export interface SourceJobCounts {
  source_id: string;
  failed_24h: number;
  queue_depth: number;
  backfill_active: number;
  backfill_queued: number;
}

/** Per-source embed-backfill state for the sync status report. */
export interface EmbedBackfillState { source_id: string; queued: number; active: number; last_completed_at: Date | null }

const CYCLE_COLUMNS = 'finished_at, name, status, started_at, result';

type RawCycle = { finished_at: Timestamp | null; name: string; status: string; started_at: Timestamp | null; result: unknown };

function cycleRow(row: RawCycle | undefined): AutopilotCycleRow | null {
  return row
    ? { finished_at: dateOrNull(row.finished_at), name: row.name, status: row.status, started_at: dateOrNull(row.started_at), result: row.result ?? null }
    : null;
}

/** The newest completed autopilot run of each kind (finished-at order; the larger id wins a tie). */
export async function readLastAutopilotCycles(tx: Raw): Promise<LastAutopilotCycles> {
  const [full] = await tx.executeRaw<RawCycle>(
    `SELECT ${CYCLE_COLUMNS}
       FROM minion_jobs
      WHERE name = 'autopilot-cycle' AND status = 'completed'
      ORDER BY finished_at DESC NULLS LAST, id DESC
      LIMIT 1`);
  const [targeted] = await tx.executeRaw<RawCycle>(
    `SELECT ${CYCLE_COLUMNS}
       FROM minion_jobs
      WHERE name LIKE 'autopilot-%' AND status = 'completed'
      ORDER BY finished_at DESC NULLS LAST, id DESC
      LIMIT 1`);
  return { full: cycleRow(full), targeted: cycleRow(targeted) };
}

/** Job counts by status, in status order, over the jobs `filter` matches (no filter counts every job, with no time window). */
export async function countJobsByStatus(tx: Raw, filter: JobStatusFilter = {}): Promise<JobStatusCount[]> {
  const rows = await tx.executeRaw<{ status: string; count: number | string }>(
    `SELECT status, count(*)::int AS count FROM minion_jobs
      WHERE ($1::text IS NULL OR name = $1::text)
        AND ($2::text IS NULL OR queue = $2::text)
        AND ($3::text[] IS NULL OR status = ANY($3::text[]))
      GROUP BY status
      ORDER BY status COLLATE "C"`,
    [filter.name ?? null, filter.queue ?? null, filter.statuses ? [...filter.statuses] : null]);
  return rows.map(r => ({ status: r.status, count: Number(r.count) }));
}

/** Waiting depth and oldest-waiting age of every queue with waiting work, deepest first (ties by queue name). */
export async function readWaitingQueueDepths(tx: Raw): Promise<QueueDepth[]> {
  const rows = await tx.executeRaw<{ queue: string; depth: number | string; oldest_waiting_age_seconds: number | string | null }>(
    `SELECT queue,
            count(*)::int AS depth,
            EXTRACT(EPOCH FROM (now() - min(created_at)))::int AS oldest_waiting_age_seconds
       FROM minion_jobs
      WHERE status = 'waiting'
      GROUP BY queue
      ORDER BY depth DESC, queue COLLATE "C"`);
  return rows.map(r => ({
    queue: r.queue,
    depth: Number(r.depth),
    oldest_waiting_age_seconds: r.oldest_waiting_age_seconds === null ? null : Number(r.oldest_waiting_age_seconds),
  }));
}

/** One source's recent whole-cycle failures (`listRecentSourceCycleFailures`). */
export interface SourceCycleFailureRow { source_id: string; fail_count: number; last_failed_at: Date }

/**
 * Dead or failed `autopilot-cycle` jobs that finished after `cutoff` (an ISO instant), grouped by `data->>'source_id'`: how
 * many, and when the last one finished. A cycle that ran but had a failed phase (`job_outcome: 'phase_failed'`) and a job
 * with no source id do not count. `sourceId` narrows to one source. Rows by source id, bytewise (the statement has no order).
 */
export async function listRecentSourceCycleFailures(tx: Raw, spec: { cutoff: string; sourceId?: string | null }): Promise<SourceCycleFailureRow[]> {
  const only = spec.sourceId ? sqlFragment` AND data->>'source_id' = ${spec.sourceId}` : sqlFragment``;
  // The statement's bytes are the old inline text (pinned in test/engine-sql-cycle-failures-pins.test.ts); sqlFragment only numbers its parameters.
  const { text, params } = renderFragment(sqlFragment`SELECT data->>'source_id' AS source_id,
              count(*)::int AS fail_count,
              max(finished_at) AS last_failed_at
         FROM minion_jobs
        WHERE name = 'autopilot-cycle'
          AND status IN ('dead','failed')
          AND (result->>'job_outcome' IS NULL OR result->>'job_outcome' <> 'phase_failed')
          AND data->>'source_id' IS NOT NULL
          AND finished_at IS NOT NULL
          AND finished_at > ${spec.cutoff}${only} GROUP BY data->>'source_id'`);
  const rows = await tx.executeRaw<{ source_id: string; fail_count: number | string; last_failed_at: Timestamp }>(text, params);
  return rows
    .map(r => ({ source_id: r.source_id, fail_count: Number(r.fail_count), last_failed_at: date(r.last_failed_at) }))
    .sort((a, b) => (a.source_id < b.source_id ? -1 : a.source_id > b.source_id ? 1 : 0));
}

/** The freshest `updated_at` among completed jobs, or null when none completed. */
export async function readLastCompletedJobAt(tx: Raw): Promise<Date | null> {
  const [row] = await tx.executeRaw<{ last_completed: Timestamp | null }>(
    `SELECT max(updated_at) AS last_completed FROM minion_jobs WHERE status = 'completed'`);
  return dateOrNull(row?.last_completed);
}

/**
 * Cancelled jobs whose `error_text` matches the LIKE pattern `reasonLike` and that finished within the last
 * `withinSeconds`, counted by job name, most first (ties by name). The waiting-TTL sweep writes the reason prefix.
 */
export async function countTtlCancelledByName(tx: Raw, reasonLike: string, withinSeconds: number): Promise<TtlCancelledCount[]> {
  const rows = await tx.executeRaw<{ name: string; count: number | string }>(
    `SELECT name, count(*)::int AS count FROM minion_jobs
      WHERE status = 'cancelled' AND error_text LIKE $1
        AND finished_at > now() - ($2::float8 * interval '1 second')
      GROUP BY name ORDER BY count(*) DESC, name COLLATE "C"`,
    [reasonLike, withinSeconds]);
  return rows.map(r => ({ name: r.name, count: Number(r.count) }));
}

/**
 * The scope state behind a returned job (`gbrain jobs stats` backpressure hints). The target is the job `jobId` when
 * it has this name and queue; its scope is its `sourceId` (or `source_id`). `waiting` counts the waiting jobs of the
 * name and queue in that scope (0 when there is no target); `live_id` and `age_min` are set only when the target is
 * active with a live lease: its id and its age in whole minutes (null without a start time).
 */
export async function readWaitingScopeState(tx: Raw, spec: { name: string; queue: string; jobId: number }): Promise<WaitingScopeState> {
  const [row] = await tx.executeRaw<{ waiting: number | string; live_id: number | string | null; age_min: number | string | null }>(
    `WITH target AS (
           SELECT id, started_at, status, lock_until,
                  COALESCE(data->>'sourceId', data->>'source_id') AS scope
             FROM minion_jobs WHERE id = $3 AND name = $1 AND queue = $2
         )
         SELECT (SELECT count(*)::int FROM minion_jobs m, target t
                  WHERE m.name = $1 AND m.queue = $2 AND m.status = 'waiting'
                    AND COALESCE(m.data->>'sourceId', m.data->>'source_id') IS NOT DISTINCT FROM t.scope) AS waiting,
                (SELECT id FROM target WHERE status = 'active' AND lock_until > now()) AS live_id,
                (SELECT floor(EXTRACT(EPOCH FROM (now() - started_at)) / 60)::int FROM target
                  WHERE status = 'active' AND lock_until > now()) AS age_min`,
    [spec.name, spec.queue, spec.jobId]);
  return {
    waiting: Number(row?.waiting ?? 0),
    live_id: row?.live_id == null ? null : Number(row.live_id),
    age_min: row?.age_min == null ? null : Number(row.age_min),
  };
}

/** Jobs named `name` that completed within the last `withinSeconds`. */
export async function countRecentCompletedJobs(tx: Raw, name: string, withinSeconds: number): Promise<number> {
  const [row] = await tx.executeRaw<{ count: number | string }>(
    `SELECT count(*)::int AS count FROM minion_jobs
      WHERE finished_at > now() - ($2::float8 * interval '1 second')
        AND status = 'completed' AND name = $1::text`,
    [name, withinSeconds]);
  return Number(row?.count ?? 0);
}

/** The id and failure text of every dead or failed job updated within the last `withinSeconds`, by id. */
export async function listRecentFailedJobErrors(tx: Raw, withinSeconds: number): Promise<FailedJobError[]> {
  const rows = await tx.executeRaw<{ id: number | string; last_error: string | null }>(
    `SELECT id, error_text AS last_error FROM minion_jobs
      WHERE status IN ('dead', 'failed')
        AND updated_at > now() - ($1::float8 * interval '1 second')
      ORDER BY id`,
    [withinSeconds]);
  return rows.map(r => ({ id: Number(r.id), last_error: r.last_error }));
}

/** A live budget-owning job: its remaining cents and the cents its budget log reserved. */
export interface BudgetOwnerRow { owner_id: number; remaining_cents: number | null; total_spent_cents: number | null }

/** The newest five jobs that own a budget and are not finished, with their reserved spend, newest id first. */
export async function listBudgetOwners(tx: Raw): Promise<BudgetOwnerRow[]> {
  return tx.executeRaw<BudgetOwnerRow>(
    `SELECT
         mj.id AS owner_id,
         mj.budget_remaining_cents AS remaining_cents,
         COALESCE((SELECT SUM(ABS(cents_delta)) FROM minion_budget_log
                    WHERE owner_id = mj.id AND event_type = 'reserved'), 0) AS total_spent_cents
       FROM minion_jobs mj
       WHERE mj.budget_remaining_cents IS NOT NULL
         AND mj.budget_owner_job_id = mj.id
         AND mj.status NOT IN ('completed', 'failed', 'dead', 'cancelled')
       ORDER BY mj.id DESC
       LIMIT 5`,
  );
}

/**
 * The average text length of the pages the queued jobs `name` on `queue` (waiting or delayed) point at, each page
 * capped at `maxChars`: the drain's cost estimate. A job names its page by `data.slug` and `data.sourceId` (default
 * source when absent); a job without a page adds nothing; a page without a compiled truth counts as `maxChars`
 * (`LEAST` skips the NULL). Null when no job has a page. Deleted pages count: the SQL never looked at `deleted_at`.
 */
export async function readQueuedPageChars(tx: Raw, spec: { name: string; queue: string; maxChars: number }): Promise<number | null> {
  const [row] = await tx.executeRaw<{ chars: number | string | null }>(
    `SELECT avg(LEAST(length(p.compiled_truth), $3::int))::float AS chars FROM minion_jobs j
       JOIN pages p ON p.slug = j.data->>'slug' AND p.source_id = COALESCE(j.data->>'sourceId', 'default')
      WHERE j.name = $1 AND j.queue = $2 AND j.status IN ('waiting', 'delayed')`,
    [spec.name, spec.queue, spec.maxChars]);
  return row?.chars == null ? null : Number(row.chars);
}

/**
 * Per-source counts over the `sync` and `embed-backfill` jobs that name a `sourceId`: failures created within the
 * last `failedWithinSeconds`, live queue depth, and the embed-backfill jobs running and queued. By source id.
 */
export async function readSourceJobCounts(tx: Raw, failedWithinSeconds: number): Promise<SourceJobCounts[]> {
  const rows = await tx.executeRaw<{
    source_id: string; failed_24h: number | string; queue_depth: number | string; backfill_active: number | string; backfill_queued: number | string;
  }>(
    `SELECT * FROM (
       SELECT data->>'sourceId' AS source_id,
              COUNT(*) FILTER (WHERE status IN ('failed','dead') AND created_at > now() - ($1::float8 * interval '1 second'))::int AS failed_24h,
              COUNT(*) FILTER (WHERE status IN ('waiting','active','delayed'))::int AS queue_depth,
              COUNT(*) FILTER (WHERE name = 'embed-backfill' AND status = 'active')::int AS backfill_active,
              COUNT(*) FILTER (WHERE name = 'embed-backfill' AND status IN ('waiting','delayed','waiting-children'))::int AS backfill_queued
         FROM minion_jobs
        WHERE name IN ('sync','embed-backfill')
          AND data->>'sourceId' IS NOT NULL
        GROUP BY data->>'sourceId') per_source
      ORDER BY source_id COLLATE "C"`,
    [failedWithinSeconds]);
  return rows.map(r => ({
    source_id: r.source_id,
    failed_24h: Number(r.failed_24h),
    queue_depth: Number(r.queue_depth),
    backfill_active: Number(r.backfill_active),
    backfill_queued: Number(r.backfill_queued),
  }));
}

/** The embed-backfill jobs of each named source: queued, active, and when one last completed. By source id. */
export async function readEmbedBackfillBySource(tx: Raw, sourceIds: readonly string[]): Promise<EmbedBackfillState[]> {
  const rows = await tx.executeRaw<{ source_id: string; queued: number | string; active: number | string; last_completed_at: Timestamp | null }>(
    `SELECT * FROM (
       SELECT data->>'sourceId' AS source_id,
              COUNT(*) FILTER (WHERE status IN ('waiting','delayed','waiting-children'))::int AS queued,
              COUNT(*) FILTER (WHERE status = 'active')::int AS active,
              MAX(finished_at) FILTER (WHERE status = 'completed') AS last_completed_at
         FROM minion_jobs
        WHERE name = 'embed-backfill' AND data->>'sourceId' = ANY($1::text[])
        GROUP BY data->>'sourceId') per_source
      ORDER BY source_id COLLATE "C"`,
    [[...sourceIds]]);
  return rows.map(r => ({
    source_id: r.source_id,
    queued: Number(r.queued),
    active: Number(r.active),
    last_completed_at: dateOrNull(r.last_completed_at),
  }));
}
