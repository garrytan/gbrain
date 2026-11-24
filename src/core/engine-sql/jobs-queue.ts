/**
 * Minion queue statements beyond the job lifecycle (engine-sql/jobs.ts): the operator writes (pause, resume, cancel,
 * retry, prune, delete), the sweeps (delayed promotion, timeouts, stranded parents), the inbox, the dream-inline
 * private queues, the stats reads and the job attachments. SQL once for both engines.
 *
 * `MinionQueue` (minions/queue.ts) keeps the policy around each statement (validation, the unreviewed-job gate, the
 * authorization of a resumed, retried or replayed job, the mapping of rows with `rowToMinionJob`); the statements,
 * and the order they run in inside one transaction, live here so a store that is not SQL can serve the same members.
 *
 * Every function takes the transaction (or the engine, for a single statement) it runs on. Rows come back raw.
 */
import type { BrainEngine } from '../engine.ts';
import { getJob, killJobs, lockParentsOrdered, type JobRow } from './jobs.ts';
import { WATCHDOG_SUSPECT_MARK } from '../minions/watchdog-attribution.ts';
import { joinFragments, renderFragment, sqlFragment, type SqlFragment } from './fragment.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

/**
 * The queue-name prefix of a dream phase's parent-owned private queue (`dream-inline-<ms>-<uuid8>`). The recovery and
 * family reads spell it as literal SQL text (`'dream-inline-%'`, family `'dream-inline'`); test/engine-sql-jobs.test.ts
 * pins the two together.
 */
export const DREAM_INLINE_PRIVATE_QUEUE_PREFIX = 'dream-inline-';

/**
 * The claim gate's population: live jobs whose authority is not exactly the application authority. Shared by
 * `assertNoUnreviewedJobs` and the doctor `legacy_job_authority` check (re-exported from submission-authority.ts).
 */
export const UNREVIEWED_LIVE_JOBS_WHERE = `status IN ('waiting','active','delayed','waiting-children','paused')
        AND submission_authority IS DISTINCT FROM '{"version":1,"kind":"application"}'::jsonb`;

/** A caller's attested actor: system, external id, member and audience key (minions/types.ts `JobActor`). */
export type JobActorTuple = readonly [string, string, string, string];

/**
 * True when the job's accepted actor and audience equal `actor`: the fragment form of `jobActorSql`
 * (minions/types.ts), which numbers its placeholders by hand.
 */
export function jobActorFragment(actor: JobActorTuple): SqlFragment {
  const [system, externalId, member, audience] = actor;
  return sqlFragment`COALESCE(submission_authority->'grant'->'actor'->>'system', '') = ${system}::text AND COALESCE(submission_authority->'grant'->'actor'->>'external_id', '') = ${externalId}::text AND COALESCE(submission_authority->'grant'->'actor'->>'member', '') = ${member}::text AND COALESCE(CASE WHEN jsonb_typeof(submission_authority->'grant'->'actingFor') = 'array' THEN (SELECT string_agg(DISTINCT e COLLATE "C", ',' ORDER BY e COLLATE "C") FROM jsonb_array_elements_text(submission_authority->'grant'->'actingFor') e) WHEN submission_authority->'grant'->'actingFor' IS NOT NULL THEN '!' END, '') = ${audience}::text`;
}

const NO_ACTOR: JobActorTuple = ['', '', '', ''];

// ---------------------------------------------------------------- writes on one job

/** Deletes a terminal job (its inbox and attachments cascade); false when it is missing or still live. */
export async function deleteTerminalJob(tx: Raw, id: number): Promise<boolean> {
  const rows = await tx.executeRaw(
    `DELETE FROM minion_jobs WHERE id = $1 AND status IN ('completed', 'dead', 'cancelled', 'failed') RETURNING id`,
    [id]);
  return rows.length > 0;
}

/** Pauses a waiting, active or delayed job, clearing its lock so a running handler aborts. */
export async function pauseJob(tx: Raw, id: number): Promise<JobRow | null> {
  const [row] = await tx.executeRaw<JobRow>(
    `UPDATE minion_jobs SET status = 'paused',
        lock_token = NULL, lock_until = NULL, updated_at = now()
       WHERE id = $1 AND status IN ('waiting', 'active', 'delayed')
       RETURNING *`,
    [id]);
  return row ?? null;
}

/** Returns a paused job to waiting. The queue authorizes the job first. */
export async function resumeJob(tx: Raw, id: number): Promise<JobRow | null> {
  const [row] = await tx.executeRaw<JobRow>(
    `UPDATE minion_jobs SET status = 'waiting',
        lock_token = NULL, lock_until = NULL, updated_at = now()
       WHERE id = $1 AND status = 'paused'
       RETURNING *`,
    [id]);
  return row ?? null;
}

/** Fails a parent waiting on its children with `errorText`. */
export async function failParentJob(tx: Raw, parentId: number, errorText: string): Promise<JobRow | null> {
  const [row] = await tx.executeRaw<JobRow>(
    `UPDATE minion_jobs SET status = 'failed', lock_token = NULL, lock_until = NULL,
        error_text = $1, finished_at = now(), updated_at = now()
       WHERE id = $2 AND status = 'waiting-children'
       RETURNING *`,
    [errorText, parentId]);
  return row ?? null;
}

/** Returns a parent waiting on its children to waiting when none of them is live. */
export async function resolveParentJob(tx: Raw, parentId: number): Promise<JobRow | null> {
  const [row] = await tx.executeRaw<JobRow>(
    `UPDATE minion_jobs SET status = 'waiting', started_at = NULL, updated_at = now()
       WHERE id = $1 AND status = 'waiting-children'
         AND NOT EXISTS (
           SELECT 1 FROM minion_jobs
           WHERE parent_job_id = $1
             AND status NOT IN ('completed', 'failed', 'dead', 'cancelled')
         )
       RETURNING *`,
    [parentId]);
  return row ?? null;
}

/** Returns every parent waiting on children with no live child to waiting; the count of parents woken. */
export async function resolveStrandedParents(tx: Raw): Promise<number> {
  const rows = await tx.executeRaw(
    `UPDATE minion_jobs SET status = 'waiting', started_at = NULL, updated_at = now()
            WHERE status = 'waiting-children'
              AND NOT EXISTS (
                SELECT 1 FROM minion_jobs c
                WHERE c.parent_job_id = minion_jobs.id
                  AND c.status NOT IN ('completed', 'failed', 'dead', 'cancelled')
              )
            RETURNING id`);
  return rows.length;
}

/** Removes a child's dependency on its parent. */
export async function detachChildJob(tx: Raw, childId: number): Promise<void> {
  await tx.executeRaw(`UPDATE minion_jobs SET parent_job_id = NULL, updated_at = now() WHERE id = $1`, [childId]);
}

/** Replaces the progress of an active job this token holds; false when the claim moved on. */
export async function updateJobProgress(tx: Raw, id: number, lockToken: string, progress: unknown): Promise<boolean> {
  const rows = await tx.executeRaw(
    `UPDATE minion_jobs SET progress = $1::jsonb, updated_at = now()
       WHERE id = $2 AND status = 'active' AND lock_token = $3
       RETURNING id`,
    [progress, id, lockToken]);
  return rows.length > 0;
}

/** Token counts a job adds to its running totals. */
export interface JobTokenCounts { input: number; output: number; cache_read: number }

/** Adds to the token counts of an active job this token holds; false when the claim moved on. */
export async function addJobTokens(tx: Raw, id: number, lockToken: string, tokens: JobTokenCounts): Promise<boolean> {
  const rows = await tx.executeRaw(
    `UPDATE minion_jobs SET
        tokens_input = tokens_input + $1,
        tokens_output = tokens_output + $2,
        tokens_cache_read = tokens_cache_read + $3,
        updated_at = now()
       WHERE id = $4 AND status = 'active' AND lock_token = $5
       RETURNING id`,
    [tokens.input, tokens.output, tokens.cache_read, id, lockToken]);
  return rows.length > 0;
}

/** How `delayActiveJob` returns a job to `delayed`. `delayMs` is already clamped by the caller. */
export interface DelayActiveJobSpec {
  errorText: string;
  delayMs: number;
  /** Append `errorText` to the stacktrace (a lease-full bounce); a deferral does not. */
  appendStack: boolean;
  /** Clear `timeout_at` (a deferral or a configuration release); a lease-full bounce keeps it. */
  clearTimeout: boolean;
}

/**
 * Returns an active job this token holds to `delayed` without counting an attempt: error text, delay, lock and
 * start cleared. Null when the claim moved on. `signal` cancels the statement on Postgres.
 */
export async function delayActiveJob(
  tx: Raw, id: number, lockToken: string, spec: DelayActiveJobSpec, opts?: { signal?: AbortSignal },
): Promise<JobRow | null> {
  const stack = spec.appendStack ? sqlFragment`
        stacktrace = COALESCE(stacktrace, '[]'::jsonb) || to_jsonb(${spec.errorText}::text),` : sqlFragment``;
  const timeout = spec.clearTimeout ? sqlFragment` timeout_at = NULL,` : sqlFragment``;
  const { text, params } = renderFragment(sqlFragment`UPDATE minion_jobs SET
        status = 'delayed',
        error_text = ${spec.errorText},${stack}
        delay_until = now() + (${spec.delayMs}::double precision * interval '1 millisecond'),
        started_at = NULL,${timeout}
        lock_token = NULL, lock_until = NULL, updated_at = now()
       WHERE id = ${id} AND status = 'active' AND lock_token = ${lockToken}
       RETURNING *`);
  const [row] = await tx.executeRaw<JobRow>(text, params, opts?.signal ? { signal: opts.signal } : undefined);
  return row ?? null;
}

/**
 * A co-runner of a watchdog drain back to `waiting`, token-fenced, with `WATCHDOG_SUSPECT_MARK` appended once and no
 * attempt burned. False when the claim moved on.
 */
export async function releaseWatchdogClaim(tx: Raw, id: number, lockToken: string, errorText: string): Promise<boolean> {
  const rows = await tx.executeRaw(
    `UPDATE minion_jobs SET status = 'waiting', error_text = $3, stacktrace = CASE WHEN COALESCE(stacktrace, '[]'::jsonb) @> jsonb_build_array($4::text) THEN stacktrace
    ELSE COALESCE(stacktrace, '[]'::jsonb) || jsonb_build_array($4::text) END,
       started_at = NULL, timeout_at = NULL, lock_token = NULL, lock_until = NULL, updated_at = now()
     WHERE id = $1 AND status = 'active' AND lock_token = $2
     RETURNING id`,
    [id, lockToken, errorText, WATCHDOG_SUSPECT_MARK]);
  return rows.length > 0;
}

/**
 * A claim a worker just took and will not run, handed back because the pause marker appeared after the claim
 * (worker.ts `releaseClaimForPause`): the row this token locks goes to `delayed` for a minute with its lock cleared.
 * Its start time, error text, attempt counts and timeout are left as the claim set them. No status guard: only a claim
 * holds a token. Nothing is returned (a stale token matches no row).
 */
export async function releaseClaimForPause(tx: Raw, id: number, lockToken: string): Promise<void> {
  await tx.executeRaw(
    `UPDATE minion_jobs
         SET status = 'delayed', lock_token = NULL, lock_until = NULL,
             delay_until = now() + interval '1 minute',
             updated_at = now()
         WHERE id = $1 AND lock_token = $2`,
    [id, lockToken]);
}

/**
 * The same hand-back for a quiet-hours deferral (worker.ts `handleQuietHoursDefer`, verdict `defer`): the row goes to
 * `delayed` for fifteen minutes so the claim query does not take it again at once. Everything else as above.
 */
export async function deferClaimForQuietHours(tx: Raw, id: number, lockToken: string): Promise<void> {
  await tx.executeRaw(
    `UPDATE minion_jobs
           SET status = 'delayed', lock_token = NULL, lock_until = NULL,
               delay_until = now() + interval '15 minutes',
               updated_at = now()
           WHERE id = $1 AND lock_token = $2`,
    [id, lockToken]);
}

/** Appends `WATCHDOG_SUSPECT_MARK` once to a job's stacktrace, in any status, without touching `updated_at`. */
export async function markJobWatchdogSuspect(tx: Raw, id: number): Promise<void> {
  await tx.executeRaw(
    `UPDATE minion_jobs SET stacktrace = CASE WHEN COALESCE(stacktrace, '[]'::jsonb) @> jsonb_build_array($2::text) THEN stacktrace
    ELSE COALESCE(stacktrace, '[]'::jsonb) || jsonb_build_array($2::text) END WHERE id = $1`,
    [id, WATCHDOG_SUSPECT_MARK]);
}

// ---------------------------------------------------------------- sweeps and multi-row writes

/** Moves delayed jobs whose delay passed back to waiting. */
export async function promoteDelayedJobs(tx: Raw): Promise<JobRow[]> {
  return tx.executeRaw<JobRow>(
    `UPDATE minion_jobs SET status = 'waiting', delay_until = NULL,
        started_at = NULL,
        lock_token = NULL, lock_until = NULL, updated_at = now()
       WHERE status = 'delayed' AND delay_until <= now()
       RETURNING *`);
}

/** Which roots `cancelJobs` cancels, and the reason stamped on them. */
export interface CancelJobsSpec {
  /** Written to `error_text` of the requested roots (an existing text is kept when null). */
  reason?: string | null;
  /** Cancel a root only while it is in one of these statuses (re-checked inside the statement). */
  rootStatuses?: readonly string[] | null;
  /** Cancel only roots whose `data.__owner_client_id` is this client and whose accepted actor is `ownerActor`. */
  ownerClientId?: string | null;
  ownerActor?: JobActorTuple | null;
}

/**
 * Cancels every live root in `ids` and its descendants (to depth 100) in one transaction, then sends each live parent
 * of a cancelled job its `child_done` (outcome and error 'cancelled') and wakes a parent with no live child left.
 */
export async function cancelJobs(tx: Raw, ids: readonly number[], spec: CancelJobsSpec = {}): Promise<JobRow[]> {
  if (ids.length === 0) return [];
  const idList = [...ids];
  const statusFence = spec.rootStatuses ? sqlFragment` AND status = ANY(${[...spec.rootStatuses]}::text[])` : sqlFragment``;
  const ownerFence = spec.ownerClientId != null
    ? sqlFragment` AND (data->>'__owner_client_id' = ${spec.ownerClientId}::text AND ${jobActorFragment(spec.ownerActor ?? NO_ACTOR)})`
    : sqlFragment``;
  const { text, params } = renderFragment(sqlFragment`WITH RECURSIVE descendants AS (
          SELECT id, 0 AS d FROM minion_jobs
           WHERE id = ANY(${idList}::int[])${statusFence}${ownerFence}
          UNION ALL
          SELECT m.id, descendants.d + 1
            FROM minion_jobs m
            JOIN descendants ON m.parent_job_id = descendants.id
            WHERE descendants.d < 100
        )
        UPDATE minion_jobs SET
          status = 'cancelled',
          lock_token = NULL,
          lock_until = NULL,
          error_text = CASE WHEN id = ANY(${idList}::int[]) THEN COALESCE(${spec.reason ?? null}::text, error_text) ELSE error_text END,
          finished_at = now(),
          updated_at = now()
         WHERE id IN (SELECT id FROM descendants)
           AND status IN ('waiting','active','delayed','waiting-children','paused')
         RETURNING *`);
  const rows = await tx.executeRaw<JobRow>(text, params);
  await killJobs(tx, rows, 'cancelled', 'cancelled');
  return rows;
}

/**
 * Dead-letters active jobs past their `timeout_at` that still hold a live lease (the drain-lease beacon excluded),
 * counting the attempt; parents are locked first, then notified and woken.
 */
export async function killTimedOutJobs(tx: Raw): Promise<JobRow[]> {
  const candidates = await tx.executeRaw<{ id: number; parent_job_id: number | null }>(
    `SELECT id, parent_job_id FROM minion_jobs
          WHERE status = 'active' AND queue <> 'gbrain-drain-lease'
            AND timeout_at IS NOT NULL
            AND timeout_at < now()
            AND lock_until > now()`);
  if (candidates.length === 0) return [];
  await lockParentsOrdered(tx, candidates);
  const rows = await tx.executeRaw<JobRow>(
    `UPDATE minion_jobs SET
          status = 'dead',
          error_text = 'timeout exceeded',
          attempts_made = attempts_made + 1,
          lock_token = NULL,
          lock_until = NULL,
          finished_at = now(),
          updated_at = now()
         WHERE id IN (
           SELECT id FROM minion_jobs
            WHERE id = ANY($1::bigint[])
              AND status = 'active'
              AND timeout_at IS NOT NULL
              AND timeout_at < now()
              AND lock_until > now()
            FOR UPDATE SKIP LOCKED
         )
         RETURNING *`,
    [candidates.map(c => c.id)]);
  await killJobs(tx, rows, 'timeout', 'timeout exceeded');
  return rows;
}

/**
 * Dead-letters active jobs running past their wall-clock threshold (twice `timeout_ms`, else twice the lease times
 * `max_stalled`; minions/handler-timeouts.ts `WALL_CLOCK_THRESHOLD_MS_SQL`), counting the attempt.
 */
export async function killWallClockJobs(tx: Raw, lockDurationMs: number): Promise<JobRow[]> {
  const candidates = await tx.executeRaw<{ id: number; parent_job_id: number | null }>(
    `SELECT id, parent_job_id FROM minion_jobs
          WHERE status = 'active' AND queue <> 'gbrain-drain-lease'
            AND started_at IS NOT NULL
            AND EXTRACT(EPOCH FROM (now() - started_at)) * 1000 > CASE
                WHEN timeout_ms IS NOT NULL THEN timeout_ms * 2
                ELSE COALESCE(lock_duration_ms, $1)::double precision * 2 * GREATEST(max_stalled, 1)
              END`,
    [lockDurationMs]);
  if (candidates.length === 0) return [];
  await lockParentsOrdered(tx, candidates);
  const rows = await tx.executeRaw<JobRow>(
    `UPDATE minion_jobs SET
          status = 'dead',
          error_text = 'wall-clock timeout exceeded',
          attempts_made = attempts_made + 1,
          lock_token = NULL,
          lock_until = NULL,
          finished_at = now(),
          updated_at = now()
         WHERE id IN (
           SELECT id FROM minion_jobs
            WHERE id = ANY($2::bigint[])
              AND status = 'active'
              AND started_at IS NOT NULL
              AND EXTRACT(EPOCH FROM (now() - started_at)) * 1000 >
                CASE
                  WHEN timeout_ms IS NOT NULL THEN timeout_ms * 2
                  ELSE COALESCE(lock_duration_ms, $1)::double precision * 2 * GREATEST(max_stalled, 1)
                END
            FOR UPDATE SKIP LOCKED
         )
         RETURNING *`,
    [lockDurationMs, candidates.map(c => c.id)]);
  await killJobs(tx, rows, 'timeout', 'wall-clock timeout exceeded');
  return rows;
}

/** Which jobs `pruneJobs` removes. */
export interface PruneJobsSpec { statuses: readonly string[]; olderThan: Date; dryRun?: boolean }

/**
 * Deletes jobs in `statuses` last updated before `olderThan` (counts them only on `dryRun`). A completed dream
 * synthesis child's idempotency key moves to `dream_synthesis_completions` first, so its transcript is not
 * synthesized again. Returns the count.
 */
export async function pruneJobs(tx: Raw, spec: PruneJobsSpec): Promise<number> {
  const params = [[...spec.statuses], spec.olderThan.toISOString()];
  if (spec.dryRun) {
    const rows = await tx.executeRaw<{ count: string }>(
      `SELECT count(*)::text as count FROM minion_jobs
         WHERE status = ANY($1) AND updated_at < $2`, params);
    return parseInt(rows[0]?.count ?? '0', 10);
  }
  const rows = await tx.executeRaw<{ count: string }>(
    `WITH pruned AS (
         DELETE FROM minion_jobs
         WHERE status = ANY($1) AND updated_at < $2
         RETURNING name, status, data, idempotency_key, finished_at
       ), archived AS (
         INSERT INTO dream_synthesis_completions (source_id, idempotency_key, completed_at)
         SELECT COALESCE(NULLIF(data->>'source_id', ''), 'default'), idempotency_key, COALESCE(finished_at, now())
           FROM pruned
          WHERE name = 'subagent' AND status = 'completed' AND idempotency_key LIKE 'dream:synth%'
         ON CONFLICT DO NOTHING
       )
       SELECT count(*)::text as count FROM pruned`, params);
  return parseInt(rows[0]?.count ?? '0', 10);
}

/** The key families a dream synthesis completion carries (`dream:synth:<hash>`, `dream:synth-v2:<hash>...`). */
export type SynthesisCompletionPrefix = 'dream:synth:' | 'dream:synth-v2:';

/** One recent synth-v2 completion: its idempotency key and when it finished. */
export interface SynthesisCompletion { idempotency_key: string; at: Date }

/**
 * The idempotency keys starting with `keyPrefix` of the source's completed dream synthesis children: the completed
 * `subagent` jobs and the `dream_synthesis_completions` archive `pruneJobs` keeps, each key once, in no set order.
 */
export async function listSynthesisCompletionKeys(tx: Raw, sourceId: string, keyPrefix: SynthesisCompletionPrefix): Promise<string[]> {
  const rows = await tx.executeRaw<{ idempotency_key: string }>(
    `SELECT idempotency_key
       FROM minion_jobs
      WHERE name = 'subagent'
        AND status = 'completed'
        AND COALESCE(NULLIF(data->>'source_id', ''), 'default') = $1
        AND idempotency_key LIKE $2
     UNION
     SELECT idempotency_key FROM dream_synthesis_completions
      WHERE source_id = $1 AND idempotency_key LIKE $2`,
    [sourceId, `${keyPrefix}%`],
  );
  return rows.map(row => row.idempotency_key);
}

/**
 * The source's `dream:synth-v2:` completions within the last `hours`, with when each finished: completed `subagent`
 * jobs, then archive rows, every row kept (a key both live and archived reads twice).
 */
export async function listRecentSynthesisCompletions(tx: Raw, sourceId: string, hours: number): Promise<SynthesisCompletion[]> {
  const rows = await tx.executeRaw<{ idempotency_key: string; at: string | Date }>(
    `SELECT idempotency_key, finished_at AS at FROM minion_jobs
      WHERE name = 'subagent' AND status = 'completed' AND finished_at > now() - ($3 || ' hours')::interval
        AND COALESCE(NULLIF(data->>'source_id', ''), 'default') = $1 AND idempotency_key LIKE $2
     UNION ALL
     SELECT idempotency_key, completed_at FROM dream_synthesis_completions
      WHERE source_id = $1 AND idempotency_key LIKE $2 AND completed_at > now() - ($3 || ' hours')::interval`,
    [sourceId, 'dream:synth-v2:%', String(hours)],
  );
  return rows.map(row => ({ idempotency_key: row.idempotency_key, at: new Date(row.at) }));
}

/** The checks `retryJob` runs on the prior row, in the retry's transaction, before the update. */
export interface RetryJobPolicy {
  /** False skips the retry (another retry won); a throw refuses it. */
  admit(tx: BrainEngine, prior: JobRow): Promise<boolean>;
}

/**
 * Re-queues a failed or dead job to run fresh (attempts, stall count, start and lock cleared) after `policy.admit`
 * passes, in one transaction. Null when the job is missing, not failed or dead, or not admitted.
 */
export async function retryJob(tx: BrainEngine, id: number, policy: RetryJobPolicy): Promise<JobRow | null> {
  const prior = await getJob(tx, id);
  if (!prior) return null;
  if (!await policy.admit(tx, prior)) return null;
  return retryJobUpdate(tx, id);
}

/** The retry's update alone. */
export async function retryJobUpdate(tx: Raw, id: number): Promise<JobRow | null> {
  const [row] = await tx.executeRaw<JobRow>(
    `UPDATE minion_jobs SET status = 'waiting', error_text = NULL,
          lock_token = NULL, lock_until = NULL, delay_until = NULL,
          finished_at = NULL, started_at = NULL, attempts_made = 0,
          attempts_started = 0, stalled_counter = 0, updated_at = now()
         WHERE id = $1 AND status IN ('failed', 'dead')
         RETURNING *`,
    [id]);
  return row ?? null;
}

// ---------------------------------------------------------------- inbox

/** Inserts one inbox message (the queue validated the sender and the job). */
export async function postInboxMessage(tx: Raw, jobId: number, sender: string, payload: unknown): Promise<JobRow> {
  const [row] = await tx.executeRaw<JobRow>(
    `INSERT INTO minion_inbox (job_id, sender, payload)
       VALUES ($1, $2, $3)
       RETURNING *`,
    [jobId, sender, payload]);
  return row!;
}

/** Marks the unread messages of an active job this token holds read and returns them; [] when the claim moved on. */
export async function readJobInbox(tx: Raw, jobId: number, lockToken: string): Promise<JobRow[]> {
  const lockCheck = await tx.executeRaw(
    `SELECT id FROM minion_jobs WHERE id = $1 AND lock_token = $2 AND status = 'active'`, [jobId, lockToken]);
  if (lockCheck.length === 0) return [];
  return tx.executeRaw<JobRow>(
    `UPDATE minion_inbox SET read_at = now()
       WHERE job_id = $1 AND read_at IS NULL
       RETURNING *`,
    [jobId]);
}

/**
 * The `child_done` payloads in an active parent's inbox (sent after `since` when given), oldest first, without
 * marking them read; [] unless this token holds the parent.
 */
export async function readChildCompletions(tx: Raw, parentId: number, lockToken: string, since?: Date | null): Promise<unknown[]> {
  const lockCheck = await tx.executeRaw(
    `SELECT id FROM minion_jobs WHERE id = $1 AND lock_token = $2 AND status = 'active'`, [parentId, lockToken]);
  if (lockCheck.length === 0) return [];
  const after = since ? sqlFragment` AND sent_at > ${since.toISOString()}::timestamptz` : sqlFragment``;
  const { text, params } = renderFragment(sqlFragment`SELECT payload FROM minion_inbox
       WHERE job_id = ${parentId} AND (payload->>'type') = 'child_done'${after}
       ORDER BY sent_at ASC, id ASC`);
  const rows = await tx.executeRaw<{ payload: unknown }>(text, params);
  return rows.map(r => (typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload));
}

// ---------------------------------------------------------------- private queues

/** Ids of the live jobs in one queue, ascending. */
export async function listOpenJobIdsInQueue(tx: Raw, queue: string): Promise<number[]> {
  const rows = await tx.executeRaw<{ id: number }>(
    `SELECT id FROM minion_jobs
        WHERE queue = $1
          AND status IN ('waiting','active','delayed','waiting-children','paused')
        ORDER BY id`,
    [queue]);
  return rows.map(r => Number(r.id));
}

/**
 * Extends (never shrinks) the owner lease of the live jobs of a private queue this owner token holds to at least
 * `leaseMs` from now; the count of jobs renewed.
 */
export async function renewPrivateQueueLease(tx: Raw, queue: string, ownerToken: string, leaseMs: number): Promise<number> {
  const rows = await tx.executeRaw(
    `UPDATE minion_jobs
          SET private_queue_lease_until = GREATEST(
                COALESCE(private_queue_lease_until, to_timestamp(0)),
                now() + ($3::text::interval)
              ),
              updated_at = now()
        WHERE queue = $1
          AND private_queue_owner_token = $2
          AND status IN ('waiting', 'active', 'delayed', 'waiting-children', 'paused')
        RETURNING id`,
    [queue, ownerToken, `${leaseMs} milliseconds`]);
  return rows.length;
}

/**
 * Private queues with live jobs and owner metadata (an owner job or a lease), oldest first, at most `maxQueues`.
 * Legacy queues without metadata never take a slot.
 */
export async function listOwnedPrivateQueues(tx: Raw, maxQueues: number): Promise<string[]> {
  // The queue order never reaches output: it only sets the order recovery judges queues in, and queue breaks a tie only on an equal min(created_at).
  const rows = await tx.executeRaw<{ queue: string }>(
    `SELECT queue
         FROM minion_jobs
        WHERE queue LIKE 'dream-inline-%'
          AND status IN ('waiting', 'active', 'delayed', 'waiting-children', 'paused')
        GROUP BY queue
        HAVING bool_or(private_queue_owner_job_id IS NOT NULL OR private_queue_lease_until IS NOT NULL)
        ORDER BY min(created_at), queue
        LIMIT $1`,
    [maxQueues]);
  return rows.map(r => r.queue);
}

/** What recovery reads about one private queue's live jobs and their owners. */
export interface PrivateQueueState {
  active_healthy: number;
  owner_ids: number[];
  metadata_rows: number;
  live_owner_rows: number;
  nonterminal_owner_rows: number;
  /** ISO text of the latest lease, or null. */
  max_lease_until: string | null;
  future_lease_rows: number;
  recently_touched: number;
}

/** The recovery verdict's inputs for one private queue (minions/queue.ts `classifyPrivateQueueForRecovery`). */
export async function readPrivateQueueState(tx: Raw, queue: string): Promise<PrivateQueueState> {
  const [r] = await tx.executeRaw<Record<string, unknown>>(
    `WITH q AS (
         SELECT *
           FROM minion_jobs
          WHERE queue = $1
            AND status IN ('waiting', 'active', 'delayed', 'waiting-children', 'paused')
       ),
       owner_ids AS (
         SELECT DISTINCT private_queue_owner_job_id AS id
           FROM q
          WHERE private_queue_owner_job_id IS NOT NULL
       ),
       owners AS (
         SELECT o.id, m.status, m.lock_until
           FROM owner_ids o
           LEFT JOIN minion_jobs m ON m.id = o.id
       )
       SELECT
         count(*) FILTER (WHERE q.status = 'active' AND q.lock_until > now()) AS active_healthy,
         COALESCE(jsonb_agg(DISTINCT q.private_queue_owner_job_id) FILTER (WHERE q.private_queue_owner_job_id IS NOT NULL), '[]'::jsonb) AS owner_ids,
         count(*) FILTER (WHERE q.private_queue_owner_job_id IS NOT NULL OR q.private_queue_lease_until IS NOT NULL) AS metadata_rows,
         (SELECT count(*) FROM owners WHERE status = 'active' AND lock_until > now()) AS live_owner_rows,
         (SELECT count(*) FROM owners WHERE status IN ('waiting','active','delayed','waiting-children','paused')) AS nonterminal_owner_rows,
         max(q.private_queue_lease_until) AS max_lease_until,
         count(*) FILTER (WHERE q.private_queue_lease_until > now()) AS future_lease_rows,
         count(*) FILTER (WHERE q.updated_at > now() - interval '120 seconds') AS recently_touched
       FROM q`,
    [queue]);
  const ids = r?.owner_ids;
  const ownerIds = (Array.isArray(ids) ? ids : typeof ids === 'string' ? JSON.parse(ids) as unknown[] : []).map(Number).sort((a, b) => a - b);
  const lease = r?.max_lease_until;
  return {
    active_healthy: Number(r?.active_healthy ?? 0),
    owner_ids: ownerIds,
    metadata_rows: Number(r?.metadata_rows ?? 0),
    live_owner_rows: Number(r?.live_owner_rows ?? 0),
    nonterminal_owner_rows: Number(r?.nonterminal_owner_rows ?? 0),
    max_lease_until: lease == null ? null : new Date(lease as string | Date).toISOString(),
    future_lease_rows: Number(r?.future_lease_rows ?? 0),
    recently_touched: Number(r?.recently_touched ?? 0),
  };
}

// ---------------------------------------------------------------- reads

/** An unfinished job's identity (`listUnfinishedJobsByName`). */
export interface UnfinishedJobRow { id: number; name: string; status: string }

/**
 * Every job of the given names that has not finished (any status but completed, failed, dead or cancelled), by id, in one
 * read: no page limit, one snapshot (remediation's report of the manual-only jobs an earlier run queued).
 */
export async function listUnfinishedJobsByName(tx: Raw, names: readonly string[]): Promise<UnfinishedJobRow[]> {
  const rows = await tx.executeRaw<{ id: number | string; name: string; status: string }>(
    `SELECT id, name, status FROM minion_jobs
          WHERE name = ANY($1::text[]) AND status NOT IN ('completed', 'failed', 'dead', 'cancelled')
          ORDER BY id`,
    [[...names]]);
  return rows.map(r => ({ id: Number(r.id), name: r.name, status: r.status }));
}

/** Ids of jobs of `name` waiting since before `hours` ago, oldest update first, at most `limit`. */
export async function listStaleWaitingJobIds(tx: Raw, name: string, hours: number, limit: number): Promise<number[]> {
  const rows = await tx.executeRaw<{ id: number }>(
    `SELECT id FROM minion_jobs
          WHERE name = $1 AND status = 'waiting'
            AND updated_at < now() - ($2 * interval '1 hour')
          ORDER BY updated_at ASC, id ASC
          LIMIT $3`,
    [name, hours, limit]);
  return rows.map(r => Number(r.id));
}

/** How many jobs of `name` have waited since before `hours` ago. */
export async function countTtlExpiredWaiting(tx: Raw, name: string, hours: number): Promise<number> {
  const rows = await tx.executeRaw<{ count: string }>(
    `SELECT count(*)::text AS count FROM minion_jobs
        WHERE name = $1 AND status = 'waiting' AND updated_at < now() - ($2 * interval '1 hour')`,
    [name, hours]);
  return parseInt(rows[0]?.count ?? '0', 10);
}

/** The raw counts behind `MinionQueue.getStats` (the queue merges and rounds them). */
export interface JobStatsRead {
  by_status: Array<{ status: string; count: number }>;
  /** Jobs created since `since`, per name; `avg_duration_ms` over the finished ones. */
  types: Array<{ name: string; total: number; completed: number; failed: number; dead: number; avg_duration_ms: number | null }>;
  /** Jobs finished since `since`, per name and terminal status. */
  drained: Array<{ name: string; completed: number; failed: number; dead: number; cancelled: number }>;
  /** Jobs waiting now, per name, and the age of the oldest in seconds. */
  depth: Array<{ name: string; waiting_now: number; oldest_waiting_seconds: number }>;
  /** Active jobs whose lease expired. */
  stalled: number;
  /** One queue's live-lease active rows, waiting rows and latest completion (Postgres timestamptz text). */
  wedge: { active_healthy: number; waiting: number; last_completed: string | null };
}

const num = (v: unknown): number => Number(v ?? 0);

/** The job statistics of the whole table, with the wedge signature of `queue`. */
export async function readJobStats(tx: Raw, since: Date, queue: string): Promise<JobStatsRead> {
  const sinceIso = since.toISOString();
  const statusRows = await tx.executeRaw<{ status: string; count: string }>(
    `SELECT status, count(*)::text as count FROM minion_jobs GROUP BY status`);
  const typeRows = await tx.executeRaw<Record<string, unknown>>(
    `SELECT name,
        count(*)::text as total,
        count(*) FILTER (WHERE status = 'completed')::text as completed,
        count(*) FILTER (WHERE status = 'failed')::text as failed,
        count(*) FILTER (WHERE status = 'dead')::text as dead,
        avg(EXTRACT(EPOCH FROM (finished_at - started_at)) * 1000) FILTER (WHERE finished_at IS NOT NULL AND started_at IS NOT NULL) as avg_duration_ms
       FROM minion_jobs WHERE created_at >= $1
       GROUP BY name ORDER BY total DESC`,
    [sinceIso]);
  const drainRows = await tx.executeRaw<Record<string, unknown>>(
    `SELECT name,
        count(*) FILTER (WHERE status = 'completed')::text AS d_completed,
        count(*) FILTER (WHERE status = 'failed')::text AS d_failed,
        count(*) FILTER (WHERE status = 'dead')::text AS d_dead,
        count(*) FILTER (WHERE status = 'cancelled')::text AS d_cancelled
       FROM minion_jobs
       WHERE finished_at IS NOT NULL AND finished_at >= $1
         AND status IN ('completed','failed','dead','cancelled')
       GROUP BY name`,
    [sinceIso]);
  const depthRows = await tx.executeRaw<Record<string, unknown>>(
    `SELECT name,
        count(*)::text AS waiting_now,
        EXTRACT(EPOCH FROM (now() - min(created_at)))::text AS oldest_waiting_seconds
       FROM minion_jobs WHERE status = 'waiting'
       GROUP BY name`);
  const stalledRows = await tx.executeRaw<{ count: string }>(
    `SELECT count(*)::text as count FROM minion_jobs WHERE status = 'active' AND lock_until < now()`);
  const [wedge] = await tx.executeRaw<{ active_healthy: string; waiting: string; last_completed: string | null }>(
    `SELECT
         count(*) FILTER (WHERE status = 'active' AND lock_until > now())::text AS active_healthy,
         count(*) FILTER (WHERE status = 'waiting')::text AS waiting,
         max(updated_at) FILTER (WHERE status = 'completed')::text AS last_completed
       FROM minion_jobs
       WHERE queue = $1`,
    [queue]);
  return {
    by_status: statusRows.map(r => ({ status: r.status, count: num(r.count) })),
    types: typeRows.map(r => ({
      name: String(r.name), total: num(r.total), completed: num(r.completed), failed: num(r.failed), dead: num(r.dead),
      avg_duration_ms: r.avg_duration_ms == null ? null : Number(r.avg_duration_ms),
    })),
    drained: drainRows.map(r => ({
      name: String(r.name), completed: num(r.d_completed), failed: num(r.d_failed), dead: num(r.d_dead), cancelled: num(r.d_cancelled),
    })),
    depth: depthRows.map(r => ({ name: String(r.name), waiting_now: num(r.waiting_now), oldest_waiting_seconds: Number(r.oldest_waiting_seconds) })),
    stalled: num(stalledRows[0]?.count),
    wedge: { active_healthy: num(wedge?.active_healthy), waiting: num(wedge?.waiting), last_completed: wedge?.last_completed ?? null },
  };
}

/** One `by_queue` line: a named queue, or every private queue folded into `dream-inline`. */
export interface QueueFamilyRow { queue: string; queues: number; waiting_now: number; active_now: number; total: number; completed: number; failed: number; dead: number }

/**
 * Per queue family: live waiting and active counts now, and the intake since `since` by terminal status. Private
 * queues fold into one family; families sort bytewise.
 */
export async function readQueueFamilyStats(tx: Raw, since: Date): Promise<QueueFamilyRow[]> {
  const rows = await tx.executeRaw<Record<string, string>>(
    `SELECT CASE WHEN queue LIKE 'dream-inline-%' THEN 'dream-inline' ELSE queue END AS queue,
       count(DISTINCT queue)::text AS queues,
       count(*) FILTER (WHERE status = 'waiting')::text AS waiting_now,
       count(*) FILTER (WHERE status = 'active')::text AS active_now,
       count(*) FILTER (WHERE created_at >= $1)::text AS total,
       count(*) FILTER (WHERE created_at >= $1 AND status = 'completed')::text AS completed,
       count(*) FILTER (WHERE created_at >= $1 AND status = 'failed')::text AS failed,
       count(*) FILTER (WHERE created_at >= $1 AND status = 'dead')::text AS dead
     FROM minion_jobs WHERE created_at >= $1 OR status IN ('waiting', 'active')
     GROUP BY 1 ORDER BY (CASE WHEN queue LIKE 'dream-inline-%' THEN 'dream-inline' ELSE queue END) COLLATE "C"`,
    [since.toISOString()]);
  return rows.map(r => ({ queue: r.queue!, queues: Number(r.queues), waiting_now: Number(r.waiting_now), active_now: Number(r.active_now),
    total: Number(r.total), completed: Number(r.completed), failed: Number(r.failed), dead: Number(r.dead) }));
}

/** Whether a waiting, authorized job of `names` in `queue` carries the watchdog mark and has waited `waitMs` since its requeue. */
export async function hasOverdueWatchdogSuspect(tx: Raw, queue: string, names: readonly string[], waitMs: number): Promise<boolean> {
  if (names.length === 0) return false;
  const rows = await tx.executeRaw<{ overdue: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM minion_jobs WHERE queue = $1 AND status = 'waiting' AND submission_authority IS NOT NULL AND name = ANY($2)
         AND ((COALESCE(stacktrace, '[]'::jsonb) @> jsonb_build_array($3::text)) AND updated_at <= now() - ($4::double precision * interval '1 millisecond'))) AS overdue`,
    [queue, [...names], WATCHDOG_SUSPECT_MARK, waitMs]);
  return rows[0]?.overdue === true;
}

/** Live jobs whose authority is not exactly the application authority, by id (the caller keeps the unparsable ones). */
export async function listUnreviewedJobs(tx: Raw): Promise<Array<{ id: number; submission_authority: unknown }>> {
  return tx.executeRaw<{ id: number; submission_authority: unknown }>(
    `SELECT id, submission_authority FROM minion_jobs
      WHERE ${UNREVIEWED_LIVE_JOBS_WHERE}
      ORDER BY id`);
}

/** The same live jobs with their status and whether the authority is SQL NULL (not JSONB null), by id: the legacy_job_authority check's population. */
export async function listUnreviewedJobAuthorities(tx: Raw): Promise<Array<{ id: number | string; status: string; submission_authority: unknown; legacy_authority_is_null: boolean }>> {
  return tx.executeRaw<{ id: number | string; status: string; submission_authority: unknown; legacy_authority_is_null: boolean }>(
    `SELECT id, status, submission_authority, submission_authority IS NULL AS legacy_authority_is_null
       FROM minion_jobs WHERE ${UNREVIEWED_LIVE_JOBS_WHERE} ORDER BY id`);
}

/** The name and data of a failed or dead job, or null. */
export async function getFailedJobForRetry(tx: Raw, id: number): Promise<{ name: string; data: Record<string, unknown> } | null> {
  const [row] = await tx.executeRaw<{ name: string; data: Record<string, unknown> }>(
    "SELECT name,data FROM minion_jobs WHERE id=$1 AND status IN ('failed','dead')", [id]);
  return row ?? null;
}

/**
 * A delegated client's open `subagent` jobs: every queue and every non-terminal status, matched on
 * `data->>'__owner_client_id'`. Coalesced existing work adds no row, so it adds no slot.
 */
export async function countOpenJobsByOwner(tx: Raw, clientId: string): Promise<number> {
  const counts = await tx.executeRaw<{ n: number }>(
    `SELECT count(*)::int AS n FROM minion_jobs
     WHERE name = 'subagent' AND status IN ('waiting','active','delayed','waiting-children','paused')
       AND data->>'__owner_client_id' = $1`, [clientId],
  );
  return Number(counts[0]?.n ?? 0);
}

/**
 * The source a remote job was accepted against: whether it is archived, when it was created, its registered root and
 * its stored config, or null. `config` is the column as the driver returns it (an object, or JSON text), so the
 * caller can refuse a malformed one.
 */
export interface JobSourceState { archived: boolean; created_at: Date; local_path: string | null; config: unknown }

/**
 * A remote job's source, for the job authority checks in minions/submission-authority.ts: `assertCurrentAgent` denies
 * an agent job when the source is gone, archived, or was created again after the job was accepted, and `sourceBoundary`
 * reads the registered root and config a generic job (sync, import, lint) runs under.
 */
export async function readJobSourceState(tx: Raw, sourceId: string): Promise<JobSourceState | null> {
  const [row] = await tx.executeRaw<{ archived: boolean; created_at: Date | string; local_path: string | null; config: unknown }>(
    'SELECT archived, created_at, local_path, config FROM sources WHERE id = $1', [sourceId]);
  return row ? { archived: row.archived, created_at: new Date(row.created_at), local_path: row.local_path ?? null, config: row.config ?? null } : null;
}

/**
 * Locks a delegated client's `oauth_clients` row until the caller's transaction ends, so its grant check, capacity
 * count and insert run as one admission. A missing client locks nothing; the grant read that follows refuses it.
 */
export async function lockOAuthClient(tx: Raw, clientId: string): Promise<void> {
  await tx.executeRaw('SELECT client_id FROM oauth_clients WHERE client_id = $1 FOR UPDATE', [clientId]);
}

/** One `list_jobs` page request. Empty filters are dropped by the caller. */
export interface JobPageSpec {
  status?: string;
  queue?: string;
  name?: string;
  ownerClientId?: string;
  ownerActor?: JobActorTuple;
  /** Rows to read (the caller asks for one more than it returns). */
  limit: number;
  /** Resume after this `(created_at microseconds, id)`. */
  cursor?: { micros: string; id: number } | null;
}

/**
 * Jobs newest first on `(created_at, id)` at microsecond precision, each with `created_us` (its `created_at` in epoch
 * microseconds as decimal text) for the next cursor.
 */
export async function listJobPage(tx: Raw, spec: JobPageSpec): Promise<JobRow[]> {
  const where: SqlFragment[] = [];
  if (spec.cursor) where.push(sqlFragment`((EXTRACT(EPOCH FROM created_at) * 1000000)::bigint, id) < (${spec.cursor.micros}::bigint, ${spec.cursor.id}::bigint)`);
  if (spec.status) where.push(sqlFragment`status = ${spec.status}`);
  if (spec.queue) where.push(sqlFragment`queue = ${spec.queue}`);
  if (spec.name) where.push(sqlFragment`name = ${spec.name}`);
  if (spec.ownerClientId) {
    where.push(sqlFragment`data->>'__owner_client_id' = ${spec.ownerClientId}`);
    where.push(jobActorFragment(spec.ownerActor ?? NO_ACTOR));
  }
  const filter = where.length ? sqlFragment`WHERE ${joinFragments(where, ' AND ')}` : sqlFragment``;
  const { text, params } = renderFragment(sqlFragment`SELECT *, ((EXTRACT(EPOCH FROM created_at) * 1000000)::bigint)::text AS created_us FROM minion_jobs ${filter}
      ORDER BY created_at DESC, id DESC LIMIT ${spec.limit}`);
  return tx.executeRaw<JobRow>(text, params);
}

// ---------------------------------------------------------------- attachments

/** One attachment to store; the queue validated and normalized it. */
export interface JobAttachmentInsert { filename: string; content_type: string; bytes: Uint8Array; size_bytes: number; sha256: string }


/** The attachment filenames of a job, or null when the job does not exist. */
export async function listJobAttachmentNames(tx: Raw, jobId: number): Promise<string[] | null> {
  const exists = await tx.executeRaw(`SELECT id FROM minion_jobs WHERE id = $1`, [jobId]);
  if (exists.length === 0) return null;
  const rows = await tx.executeRaw<{ filename: string }>(`SELECT filename FROM minion_attachments WHERE job_id = $1`, [jobId]);
  return rows.map(r => r.filename);
}

/** Stores one attachment and returns its metadata (no bytes). A duplicate filename violates the unique index. */
export async function insertJobAttachment(tx: Raw, jobId: number, a: JobAttachmentInsert): Promise<JobRow> {
  const [row] = await tx.executeRaw<JobRow>(
    `INSERT INTO minion_attachments (job_id, filename, content_type, content, size_bytes, sha256)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, job_id, filename, content_type, storage_uri, size_bytes, sha256, created_at`,
    [jobId, a.filename, a.content_type, a.bytes, a.size_bytes, a.sha256]);
  return row!;
}

/** The attachment metadata of a job, oldest first. */
export async function listJobAttachments(tx: Raw, jobId: number): Promise<JobRow[]> {
  return tx.executeRaw<JobRow>(
    `SELECT id, job_id, filename, content_type, storage_uri, size_bytes, sha256, created_at
       FROM minion_attachments
       WHERE job_id = $1
       ORDER BY created_at ASC, id ASC`,
    [jobId]);
}

/** One attachment with its `content` bytes, or null. */
export async function getJobAttachment(tx: Raw, jobId: number, filename: string): Promise<JobRow | null> {
  const [row] = await tx.executeRaw<JobRow>(
    `SELECT id, job_id, filename, content_type, storage_uri, size_bytes, sha256, created_at, content
       FROM minion_attachments
       WHERE job_id = $1 AND filename = $2`,
    [jobId, filename]);
  return row ?? null;
}

/** Deletes one attachment; false when there was none. */
export async function deleteJobAttachment(tx: Raw, jobId: number, filename: string): Promise<boolean> {
  const rows = await tx.executeRaw(`DELETE FROM minion_attachments WHERE job_id = $1 AND filename = $2 RETURNING id`, [jobId, filename]);
  return rows.length > 0;
}
