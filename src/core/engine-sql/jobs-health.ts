/**
 * Queue health reads (lane 5, group A): what `gbrain doctor`'s queue checks, the advisor's stalled-jobs collector and
 * the submit-time queue probe ask of `minion_jobs`. SQL once for both engines; a store that is not SQL serves the same
 * members (rust/docs/store/jobs-health.md).
 *
 * Each read is the statement its caller ran through `executeRaw`, with the counts as numbers and the ties the old
 * statement left to the planner broken bytewise (`COLLATE "C"`, the order a Rust store sorts in). The windows and cut-offs
 * the callers fixed in the statement text (24 hours, 1 hour) are arguments, so a case can move every row outside a
 * window without waiting out a clock.
 *
 * Every function takes the engine (or a transaction) it runs on. `opts.signal` reaches the statement as it did on
 * `executeRaw`, so a timed-out probe still cancels its query.
 */
import type { BrainEngine } from '../engine.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;
type Signal = { signal?: AbortSignal };

const num = (v: unknown): number => Number(v ?? 0);
const numOrNull = (v: unknown): number | null => (v == null ? null : Number(v));

// ---------------------------------------------------------------- doctor: queue_health (Postgres and Rust branch)

/** The cut-offs of `computeQueueHealthCheck`'s statements; the check passes its own settings and 24 and 1 hours. */
export interface QueueHealthSpec {
  /** A name and queue is listed when more than this many jobs wait on it. */
  waitingThreshold: number;
  /** An `embed-backfill` queue is listed when its oldest waiting job is older than this many hours. */
  oldWaitingHours: number;
  /** The look-back of the watchdog-kill and prompt_too_long counts, in hours. */
  windowHours: number;
  /** An active job is stalled-forever when it started more than this many hours ago. */
  stalledAfterHours: number;
}

/** What the `queue_health` check reads, but not the per-queue waiting list (`listWaitingByQueue`). */
export interface QueueHealthSignals {
  /** The five oldest stalled-forever active jobs, oldest start first; `total` counts every one. */
  stalled: Array<{ id: number; name: string; total: number }>;
  /** Waiting depth per name and queue above the threshold, deepest first, at most five. */
  depth: Array<{ name: string; queue: string; depth: number }>;
  /** Jobs dead-lettered or failed by the RSS watchdog inside the window. */
  rss_kills: number;
  /** Dead `subagent` jobs with a `prompt_too_long:` error inside the window, by dream phase. */
  prompt_too_long: Array<{ phase: 'patterns' | 'synthesize' | 'other'; cnt: number }>;
  /** Waiting `embed-backfill` jobs per queue whose oldest is past `oldWaitingHours`, oldest first. */
  old_embed_backfill: Array<{ name: string; queue: string; depth: number; oldest_age_seconds: number }>;
}

export async function readQueueHealthSignals(tx: Raw, spec: QueueHealthSpec): Promise<QueueHealthSignals> {
  // issue #1801: column is `status`, not `state`. #7145: total counts every stalled job, not only the five listed.
  const stalled = await tx.executeRaw<{ id: number | string; name: string; total: number | string }>(
    `SELECT id, name, count(*) OVER ()::int AS total
       FROM minion_jobs
      WHERE status = 'active'
        AND started_at IS NOT NULL
        AND started_at < now() - ($1 * interval '1 hour')
      ORDER BY started_at ASC, id ASC
      LIMIT 5`,
    [spec.stalledAfterHours]);
  const depth = await tx.executeRaw<{ name: string; queue: string; depth: number | string }>(
    `SELECT name, queue, count(*)::int AS depth
       FROM minion_jobs
      WHERE status = 'waiting'
      GROUP BY name, queue
     HAVING count(*) > $1
      ORDER BY depth DESC, name COLLATE "C", queue COLLATE "C"
      LIMIT 5`,
    [spec.waitingThreshold]);
  const rss = await tx.executeRaw<{ cnt: number | string }>(
    `SELECT count(*)::int AS cnt
       FROM minion_jobs
      WHERE status IN ('dead', 'failed')
        AND finished_at > now() - ($1 * interval '1 hour')
        AND error_text = 'aborted: watchdog'`,
    [spec.windowHours]);
  const promptTooLong = await tx.executeRaw<{ phase: 'patterns' | 'synthesize' | 'other'; cnt: number | string }>(
    `SELECT phase, count(*)::int AS cnt
       FROM (SELECT CASE WHEN key LIKE 'dream:patterns:%' THEN 'patterns'
                         WHEN key LIKE 'dream:synth%' THEN 'synthesize'
                         ELSE 'other' END AS phase
               FROM (SELECT COALESCE(idempotency_key, data->>'__released_idempotency_key') AS key
                       FROM minion_jobs
                      WHERE name = 'subagent'
                        AND status = 'dead'
                        AND finished_at > now() - ($1 * interval '1 hour')
                        AND error_text LIKE 'prompt_too_long:%') dead) phased
      GROUP BY phase
      ORDER BY phase COLLATE "C"`,
    [spec.windowHours]);
  const oldWaiting = await tx.executeRaw<{ name: string; queue: string; depth: number | string; oldest_age_seconds: number | string }>(
    `SELECT name,
            queue,
            count(*)::int AS depth,
            EXTRACT(EPOCH FROM (now() - min(created_at)))::int AS oldest_age_seconds
       FROM minion_jobs
      WHERE status = 'waiting'
        AND name = 'embed-backfill'
      GROUP BY name, queue
     HAVING min(created_at) < now() - ($1::text::interval)
      ORDER BY oldest_age_seconds DESC, queue COLLATE "C"`,
    [`${spec.oldWaitingHours} hours`]);
  return {
    stalled: stalled.map(r => ({ id: num(r.id), name: r.name, total: num(r.total) })),
    depth: depth.map(r => ({ name: r.name, queue: r.queue, depth: num(r.depth) })),
    rss_kills: num(rss[0]?.cnt),
    prompt_too_long: promptTooLong.map(r => ({ phase: r.phase, cnt: num(r.cnt) })),
    old_embed_backfill: oldWaiting.map(r => ({ name: r.name, queue: r.queue, depth: num(r.depth), oldest_age_seconds: num(r.oldest_age_seconds) })),
  };
}

/** One queue's waiting jobs: how many, and the age of the oldest in whole seconds. */
export interface WaitingByQueueRow { queue: string; depth: number; oldest_age_seconds: number | null }

/**
 * Waiting jobs per queue, deepest first and by name on a tie. `queue_health` sums them (Postgres, Rust) or lists them
 * (PGLite), and reads which queues hold work.
 *
 * Perf note (twin of buildQueueDepths in status.ts): WHERE constrains only `status` — the second column of the
 * (queue, status, updated_at) wedge index — so this GROUP BY full-scans minion_jobs today. Acceptable at doctor
 * frequency over pruned waiting sets; a partial (queue, created_at) WHERE status='waiting' index is the fix if hot.
 */
export async function listWaitingByQueue(tx: Raw): Promise<WaitingByQueueRow[]> {
  const rows = await tx.executeRaw<{ queue: string; depth: number | string; oldest_age_seconds: number | string | null }>(
    `SELECT queue, count(*)::int AS depth, EXTRACT(EPOCH FROM (now() - min(created_at)))::int AS oldest_age_seconds
       FROM minion_jobs WHERE status = 'waiting' GROUP BY queue ORDER BY count(*) DESC, queue COLLATE "C"`);
  return rows.map(r => ({ queue: r.queue, depth: num(r.depth), oldest_age_seconds: numOrNull(r.oldest_age_seconds) }));
}

/** The cut-offs of the divergence read. */
export interface QueueDivergenceSpec {
  /** The look-back of intake, completions and cancellations, in hours. */
  windowHours: number;
  /** The `error_text` prefix of a waiting-TTL cancellation (`TTL_REASON_PREFIX`). */
  ttlReasonPrefix: string;
}

/** Per job name with work waiting: intake and completions inside the window, and the waiting-TTL cancellations. */
export interface QueueDivergence {
  /** One row per name with a waiting job, by name. */
  divergence: Array<{ name: string; intake: number; completed: number; waiting: number }>;
  /** Cancelled jobs whose reason starts with the prefix, finished inside the window, per name, by name. */
  ttl_cancelled: Array<{ name: string; count: number }>;
}

export async function readQueueDivergence(tx: Raw, spec: QueueDivergenceSpec): Promise<QueueDivergence> {
  const div = await tx.executeRaw<{ name: string; intake: string; completed: string; waiting: string }>(
    `SELECT w.name,
            COALESCE(i.intake, '0') AS intake,
            COALESCE(c.completed, '0') AS completed,
            w.waiting
       FROM (SELECT name, count(*)::text AS waiting FROM minion_jobs
              WHERE status = 'waiting' GROUP BY name) w
       LEFT JOIN (SELECT name, count(*)::text AS intake FROM minion_jobs
              WHERE created_at > now() - ($1 * interval '1 hour') GROUP BY name) i ON i.name = w.name
       LEFT JOIN (SELECT name, count(*)::text AS completed FROM minion_jobs
              WHERE finished_at > now() - ($1 * interval '1 hour') AND status = 'completed'
              GROUP BY name) c ON c.name = w.name
      ORDER BY w.name COLLATE "C"`,
    [spec.windowHours]);
  const ttl = await tx.executeRaw<{ name: string; count: string }>(
    `SELECT name, count(*)::text AS count FROM minion_jobs
      WHERE status = 'cancelled' AND error_text LIKE $1
        AND finished_at > now() - ($2 * interval '1 hour')
      GROUP BY name
      ORDER BY name COLLATE "C"`,
    [`${spec.ttlReasonPrefix}%`, spec.windowHours]);
  return {
    divergence: div.map(r => ({ name: r.name, intake: parseInt(r.intake, 10), completed: parseInt(r.completed, 10), waiting: parseInt(r.waiting, 10) })),
    ttl_cancelled: ttl.map(r => ({ name: r.name, count: parseInt(r.count, 10) })),
  };
}

// ---------------------------------------------------------------- doctor: wedged_queue and orphaned_private_queue

/** One queue's wedge signature. `mins_since_completion` is null when nothing in the queue ever completed. */
export interface QueueWedgeRow { queue: string; active_healthy: number; waiting: number; mins_since_completion: number | null }

/**
 * Per queue (private dream queues excluded): live-lease active rows, waiting rows and the minutes since the latest
 * completion (by `updated_at`). `active_healthy` counts only live-lock rows, so an expired-lock active row (a worker
 * that died mid-job) does not mask a wedge (Codex #6).
 */
export async function listQueueWedgeCounts(tx: Raw): Promise<QueueWedgeRow[]> {
  const rows = await tx.executeRaw<{ queue: string; active_healthy: string | number; waiting: string | number; mins_since_completion: string | number | null }>(
    `SELECT queue,
       count(*) FILTER (WHERE status = 'active' AND lock_until > now()) AS active_healthy,
       count(*) FILTER (WHERE status = 'waiting') AS waiting,
       EXTRACT(EPOCH FROM (now() - max(updated_at) FILTER (WHERE status = 'completed'))) / 60
         AS mins_since_completion
     FROM minion_jobs
     WHERE queue NOT LIKE 'dream-inline-%'
     GROUP BY queue
     ORDER BY queue COLLATE "C"`);
  return rows.map(r => ({ queue: r.queue, active_healthy: num(r.active_healthy), waiting: num(r.waiting), mins_since_completion: numOrNull(r.mins_since_completion) }));
}

/** One dream-inline private queue as the orphan check reads it. */
export interface PrivateQueueHealthRow {
  queue: string;
  /** The smallest `data.source_id` of the queue's jobs (bytewise), or null. */
  source_id: string | null;
  active_healthy: number;
  /** Waiting-class rows: `waiting` and `delayed`. */
  waiting: number;
  paused: number;
  /** Minutes since the oldest waiting-class row was created, or null with none. */
  oldest_waiting_minutes: number | null;
  /** The oldest row's `created_at` as epoch milliseconds (any status). */
  birth_epoch_ms: number | null;
}

/** Per private dream queue (`dream-inline-%`), by queue name. */
export async function listPrivateQueueHealth(tx: Raw): Promise<PrivateQueueHealthRow[]> {
  const rows = await tx.executeRaw<Record<string, unknown>>(
    `SELECT queue,
       min(data->>'source_id' COLLATE "C") AS source_id,
       count(*) FILTER (WHERE status = 'active' AND lock_until > now()) AS active_healthy,
       count(*) FILTER (WHERE status IN ('waiting','delayed')) AS waiting,
       count(*) FILTER (WHERE status = 'paused') AS paused,
       EXTRACT(EPOCH FROM (now() - min(created_at) FILTER (WHERE status IN ('waiting','delayed')))) / 60
         AS oldest_waiting_minutes,
       EXTRACT(EPOCH FROM min(created_at)) * 1000 AS birth_epoch_ms
     FROM minion_jobs
     WHERE queue LIKE 'dream-inline-%'
     GROUP BY queue
     ORDER BY queue COLLATE "C"`);
  return rows.map(r => ({
    queue: String(r.queue), source_id: r.source_id == null ? null : String(r.source_id), active_healthy: num(r.active_healthy),
    waiting: num(r.waiting), paused: num(r.paused), oldest_waiting_minutes: numOrNull(r.oldest_waiting_minutes), birth_epoch_ms: numOrNull(r.birth_epoch_ms),
  }));
}

// ---------------------------------------------------------------- supervisor probe and advisor

/**
 * One queue's wedge signals (`WedgeSignals` in minions/supervisor.ts): stalled and live-lease active rows, waiting rows,
 * waiting rows a handler could claim now, and the latest completion overall and on the handled names.
 */
export interface QueueWedgeSignals {
  stalled: number;
  activeHealthy: number;
  waiting: number;
  waitingClaimable: number;
  lastCompleted: Date | null;
  lastCompletedClaimable: Date | null;
}

export async function readWedgeSignals(tx: Raw, queue: string, handlerNames: readonly string[], opts?: Signal): Promise<QueueWedgeSignals> {
  const rows = await tx.executeRaw<{
    stalled: string; active_healthy: string; waiting: string; waiting_claimable: string;
    last_completed: string | null; last_completed_claimable: string | null;
  }>(
    `SELECT
       count(*) FILTER (WHERE status = 'active' AND lock_until < now())::text AS stalled,
       count(*) FILTER (WHERE status = 'active' AND lock_until > now())::text AS active_healthy,
       count(*) FILTER (WHERE status = 'waiting')::text AS waiting,
       count(*) FILTER (WHERE (status = 'waiting'
                          OR (status = 'delayed' AND delay_until <= now()))
                         AND name = ANY($2::text[]))::text AS waiting_claimable,
       max(updated_at) FILTER (WHERE status = 'completed')::text AS last_completed,
       max(updated_at) FILTER (WHERE status = 'completed'
                               AND name = ANY($2::text[]))::text AS last_completed_claimable
     FROM minion_jobs
     WHERE queue = $1`,
    [queue, [...handlerNames]],
    opts,
  );
  const row = rows[0] ?? {
    stalled: '0', active_healthy: '0', waiting: '0',
    waiting_claimable: '0', last_completed: null, last_completed_claimable: null,
  };
  return {
    stalled: parseInt(row.stalled ?? '0', 10),
    activeHealthy: parseInt(row.active_healthy ?? '0', 10),
    waiting: parseInt(row.waiting ?? '0', 10),
    waitingClaimable: parseInt(row.waiting_claimable ?? '0', 10),
    lastCompleted: row.last_completed ? new Date(row.last_completed) : null,
    lastCompletedClaimable: row.last_completed_claimable ? new Date(row.last_completed_claimable) : null,
  };
}

/** The age in whole seconds of the oldest waiting job in `queue`, or null with none. */
export async function readOldestWaitingAge(tx: Raw, queue: string, opts?: Signal): Promise<number | null> {
  const rows = await tx.executeRaw<{ age: number | string | null }>(
    `SELECT EXTRACT(EPOCH FROM (now() - min(created_at)))::int AS age
       FROM minion_jobs
      WHERE queue = $1 AND status = 'waiting'`,
    [queue],
    opts,
  );
  return numOrNull(rows[0]?.age);
}

/** The queue a facts-drain no-worker warning names: its count of untaken waiting `name` jobs and the age of the oldest. */
export interface UntakenWaitingJobs { queue: string; waiting: number; oldest_age_seconds: number }

/**
 * The queue whose waiting `name` jobs nothing is running (moved from minions/no-worker.ts untakenWaitingJobs unchanged):
 * one such claimable job has waited past `thresholdHours` since it last became waiting, and no job on that queue holds a
 * live lock or started within that time; the queue with the oldest such job, or null.
 */
export async function readUntakenWaitingJobs(tx: Raw, name: string, thresholdHours: number): Promise<UntakenWaitingJobs | null> {
  const [row] = await tx.executeRaw<{ queue: string; waiting: number; oldest_age_seconds: number }>(
    `WITH stuck AS (
       SELECT queue, count(*)::int AS waiting, EXTRACT(EPOCH FROM (now() - min(updated_at)))::int AS oldest_age_seconds
         FROM minion_jobs
        WHERE name = $1 AND status = 'waiting' AND submission_authority IS NOT NULL
        GROUP BY queue
       HAVING min(updated_at) < now() - $2::text::interval
     )
     SELECT queue, waiting, oldest_age_seconds FROM stuck s
      WHERE NOT EXISTS (SELECT 1 FROM minion_jobs j WHERE j.queue = s.queue
        AND ((j.status = 'active' AND j.lock_until > now()) OR j.started_at > now() - $2::text::interval))
      ORDER BY oldest_age_seconds DESC
      LIMIT 1`,
    [name, `${thresholdHours} hours`],
  );
  return row ? { queue: row.queue, waiting: Number(row.waiting), oldest_age_seconds: Number(row.oldest_age_seconds) } : null;
}

/**
 * How many jobs wait, for the readiness worker probe. `excludeFactsAbsorb` leaves out `facts-absorb` jobs, which PGLite's
 * automatic facts drain owns (its own readiness entry), not a worker.
 */
export async function countWaitingJobs(tx: Raw, excludeFactsAbsorb: boolean): Promise<number> {
  const [row] = await tx.executeRaw<{ n: number }>(excludeFactsAbsorb
    ? `SELECT count(*)::int AS n FROM minion_jobs WHERE status = 'waiting' AND name <> 'facts-absorb'`
    : `SELECT count(*)::int AS n FROM minion_jobs WHERE status = 'waiting'`);
  return num(row?.n);
}

/**
 * How many jobs of `queue` wait under one of `names`: the minion worker's stall check, which counts only the work its
 * own handlers would claim. An empty `names` counts none (the worker skips the call then).
 */
export async function countWaitingJobsForNames(tx: Raw, queue: string, names: readonly string[]): Promise<number> {
  const rows = await tx.executeRaw<{ cnt: string }>(
    `SELECT count(*)::text AS cnt FROM minion_jobs
                     WHERE status = 'waiting'
                       AND queue = $1
                       AND name = ANY($2::text[])`,
    [queue, names],
  );
  return parseInt(rows[0]?.cnt ?? '0', 10);
}

/** Active jobs whose lock lapsed or whose stalled counter reached two, per name, most first and by name on a tie. */
export async function listStuckActiveJobsByName(tx: Raw): Promise<Array<{ name: string; n: number }>> {
  const rows = await tx.executeRaw<{ name: string; n: number | string }>(
    `SELECT name, count(*)::int AS n
       FROM minion_jobs
      WHERE status = 'active'
        AND (lock_until < now() OR stalled_counter >= 2)
      GROUP BY name
      ORDER BY n DESC, name COLLATE "C"`);
  return rows.map(r => ({ name: r.name, n: num(r.n) }));
}
