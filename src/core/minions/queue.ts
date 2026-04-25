/**
 * MinionQueue — Postgres-native job queue inspired by BullMQ.
 *
 * Usage:
 *   const queue = new MinionQueue(engine);
 *   const job = await queue.add('sync', { full: true });
 *   const status = await queue.getJob(job.id);
 *   await queue.prune({ olderThan: new Date(Date.now() - 30 * 86400000) });
 */

import type { BrainEngine } from '../engine.ts';
import type {
  MinionJob, MinionJobInput, MinionJobStatus, InboxMessage, TokenUpdate,
  MinionQueueOpts, ChildDoneMessage, Attachment, AttachmentInput,
} from './types.ts';
import { rowToMinionJob, rowToInboxMessage, rowToAttachment } from './types.ts';
import { validateAttachment } from './attachments.ts';
import { isProtectedJobName } from './protected-names.ts';

/** Options for opting into protected-job-name submission. Passed as a separate
 *  4th arg to `MinionQueue.add()` (NOT folded into `opts`) so user-spread
 *  `{...userOpts}` payloads can't accidentally carry the trust flag. */
export interface TrustedSubmitOpts {
  /** When true, allow submission of names in PROTECTED_JOB_NAMES (currently 'shell').
   *  Set only by the CLI path and by `submit_job` when `ctx.remote === false`. */
  allowProtectedSubmit?: boolean;
}

const MIGRATION_VERSION = 7;

const DEFAULT_MAX_SPAWN_DEPTH = 5;
const DEFAULT_MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024; // 5 MiB

const TERMINAL_STATUSES = ['completed', 'failed', 'dead', 'cancelled'] as const;

export class MinionQueue {
  readonly maxSpawnDepth: number;
  readonly maxAttachmentBytes: number;

  constructor(private engine: BrainEngine, opts: MinionQueueOpts = {}) {
    this.maxSpawnDepth = opts.maxSpawnDepth ?? DEFAULT_MAX_SPAWN_DEPTH;
    this.maxAttachmentBytes = opts.maxAttachmentBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;
  }

  /** Verify minion_jobs table exists (migration v5+). Call before first operation. */
  async ensureSchema(): Promise<void> {
    const ver = await this.engine.getConfig('version');
    const current = parseInt(ver || '1', 10);
    if (current < MIGRATION_VERSION) {
      throw new Error(
        `minion_jobs table not found (schema version ${current}, need ${MIGRATION_VERSION}). Run 'gbrain init' to apply migrations.`
      );
    }
  }

  /**
   * Submit a new job.
   *
   * Wrapped in engine.transaction(): when parent_job_id is set, takes
   * SELECT ... FOR UPDATE on the parent so concurrent submissions serialize
   * on the cap check. Without this, two concurrent submissions could both
   * see count = N-1 and both insert, blowing max_children.
   *
   * Child status is 'waiting' (or 'delayed') — claimable. Parent is flipped
   * to 'waiting-children' atomically. Idempotency_key dedups via PG unique
   * partial index; same key returns the existing row (no second insert).
   */
  async add(
    name: string,
    data?: Record<string, unknown>,
    opts?: Partial<MinionJobInput>,
    trusted?: TrustedSubmitOpts,
  ): Promise<MinionJob> {
    // Normalize first so the protected-name check and the insert use the same
    // canonical form. Without the trim-before-check, `queue.add(' shell ', ...)`
    // would evade the guard and insert a job literally named 'shell'.
    const jobName = (name || '').trim();
    if (jobName.length === 0) {
      throw new Error('Job name cannot be empty');
    }
    if (isProtectedJobName(jobName) && !trusted?.allowProtectedSubmit) {
      throw new Error(
        `protected job name '${jobName}' requires CLI or operation-local submitter ` +
        `(pass {allowProtectedSubmit: true} as the 4th arg to MinionQueue.add)`,
      );
    }
    await this.ensureSchema();

    const childStatus: MinionJobStatus = opts?.delay ? 'delayed' : 'waiting';
    const delayUntil = opts?.delay ? new Date(Date.now() + opts.delay) : null;
    const maxSpawnDepth = opts?.max_spawn_depth ?? this.maxSpawnDepth;

    return this.engine.transaction(async (tx) => {
      // 1. Idempotency fast path — if a row already exists for this key, return it
      //    without doing any other work. The unique partial index guarantees
      //    no second row can be inserted with the same non-null key.
      if (opts?.idempotency_key) {
        const existing = await tx.executeRaw<Record<string, unknown>>(
          `SELECT * FROM minion_jobs WHERE idempotency_key = $1`,
          [opts.idempotency_key]
        );
        if (existing.length > 0) return rowToMinionJob(existing[0]);
      }

      // 1b. Submission-time backpressure for high-frequency named jobs.
      // If waiting jobs for this (name, queue) already hit maxWaiting, return
      // the most-recent waiting row instead of inserting another slot.
      //
      // Correctness: two concurrent submitters could both see waitingCount <
      // maxWaiting and both insert, violating the cap. `pg_advisory_xact_lock`
      // keyed on (name, queue) serializes concurrent count+insert decisions
      // for the SAME key while leaving different keys fully parallel. The
      // lock releases on txn commit/rollback automatically — no cleanup path
      // to leak. Cost: one no-op SELECT on the hot path per coalesce-guarded
      // submission; trivial compared to the protection.
      //
      // Queue scope: the filter includes `queue=$2` so a waiting
      // 'autopilot-cycle' in queue 'default' does NOT suppress submissions
      // to queue 'shell' with the same name. Pre-D2 code filtered on `name`
      // alone — a real cross-queue bleed that sequential tests missed.
      //
      // Engine compatibility: PGLite (WASM Postgres 17) supports
      // pg_advisory_xact_lock, so this works on both engines without branching.
      if (opts?.maxWaiting !== undefined) {
        const maxWaiting = Math.max(1, Math.floor(opts.maxWaiting));
        const backpressureQueue = opts?.queue ?? 'default';
        await tx.executeRaw(
          `SELECT pg_advisory_xact_lock(hashtext('minion_maxwaiting:' || $1 || ':' || $2))`,
          [jobName, backpressureQueue]
        );
        const waitingCountRows = await tx.executeRaw<{ count: string }>(
          `SELECT count(*)::text AS count
           FROM minion_jobs
           WHERE name = $1 AND queue = $2 AND status = 'waiting'`,
          [jobName, backpressureQueue]
        );
        const waitingCount = parseInt(waitingCountRows[0]?.count ?? '0', 10);
        if (waitingCount >= maxWaiting) {
          const existingWaiting = await tx.executeRaw<Record<string, unknown>>(
            `SELECT * FROM minion_jobs
             WHERE name = $1 AND queue = $2 AND status = 'waiting'
             ORDER BY created_at DESC, id DESC
             LIMIT 1`,
            [jobName, backpressureQueue]
          );
          if (existingWaiting.length > 0) {
            const coalesced = rowToMinionJob(existingWaiting[0]);
            try {
              const { logBackpressureCoalesce } = await import('./backpressure-audit.ts');
              logBackpressureCoalesce({
                queue: backpressureQueue,
                name: jobName,
                waiting_count: waitingCount,
                max_waiting: maxWaiting,
                returned_job_id: coalesced.id,
              });
            } catch { /* audit failures never block submission */ }
            return coalesced;
          }
        }
      }

      // 2. Parent lock + depth/cap validation
      let depth = 0;
      if (opts?.parent_job_id) {
        const parentRows = await tx.executeRaw<Record<string, unknown>>(
          `SELECT * FROM minion_jobs WHERE id = $1 FOR UPDATE`,
          [opts.parent_job_id]
        );
        if (parentRows.length === 0) {
          throw new Error(`parent_job_id ${opts.parent_job_id} not found`);
        }
        const parent = rowToMinionJob(parentRows[0]);

        depth = parent.depth + 1;
        if (depth > maxSpawnDepth) {
          throw new Error(`spawn depth ${depth} exceeds maxSpawnDepth ${maxSpawnDepth}`);
        }

        if (parent.max_children !== null) {
          const countRows = await tx.executeRaw<{ count: string }>(
            `SELECT count(*)::text as count FROM minion_jobs
             WHERE parent_job_id = $1 AND status NOT IN ('completed','failed','dead','cancelled')`,
            [opts.parent_job_id]
          );
          const live = parseInt(countRows[0]?.count ?? '0', 10);
          if (live >= parent.max_children) {
            throw new Error(`parent ${opts.parent_job_id} already has ${live} live children (max_children=${parent.max_children})`);
          }
        }
      }

      // 3. Insert child. Use ON CONFLICT for idempotency; if a concurrent submit
      //    raced past the fast-path SELECT, the unique index catches it here.
      //    quiet_hours + stagger_key always present (null fallback; schema
      //    stores NULL). max_stalled is conditional: provided values get
      //    clamped to [1, 100] and included in the INSERT; omitted values
      //    skip the column so the schema DEFAULT (5 as of v0.14.1) kicks in.
      //    Keeps the app layer from hardcoding the schema default constant.
      //
      //    Footgun note (codex iter 3): threading max_stalled on INSERT only is
      //    deliberate. An idempotency-key hit returns the EXISTING row via the
      //    fast-path SELECT above — we do NOT UPDATE max_stalled on a re-submit,
      //    because letting a second submitter mutate the first submitter's
      //    durability semantics is a nasty surprise.
      const hasMaxStalled = opts?.max_stalled !== undefined && opts.max_stalled !== null;
      const clampedMaxStalled = hasMaxStalled
        ? Math.max(1, Math.min(100, Math.floor(opts!.max_stalled as number)))
        : null;

      const baseCols = `name, queue, status, priority, data, max_attempts, backoff_type,
            backoff_delay, backoff_jitter, delay_until, parent_job_id, on_child_fail,
            depth, max_children, timeout_ms, remove_on_complete, remove_on_fail, idempotency_key,
            quiet_hours, stagger_key`;
      const baseVals = `$1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19::jsonb, $20`;
      const cols = hasMaxStalled ? `${baseCols}, max_stalled` : baseCols;
      const vals = hasMaxStalled ? `${baseVals}, $21` : baseVals;

      const insertSql = opts?.idempotency_key
        ? `INSERT INTO minion_jobs (${cols})
           VALUES (${vals})
           ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
           RETURNING *`
        : `INSERT INTO minion_jobs (${cols})
           VALUES (${vals})
           RETURNING *`;

      const params: unknown[] = [
        jobName,
        opts?.queue ?? 'default',
        childStatus,
        opts?.priority ?? 0,
        data ?? {},
        opts?.max_attempts ?? 3,
        opts?.backoff_type ?? 'exponential',
        opts?.backoff_delay ?? 1000,
        opts?.backoff_jitter ?? 0.2,
        delayUntil?.toISOString() ?? null,
        opts?.parent_job_id ?? null,
        opts?.on_child_fail ?? 'fail_parent',
        depth,
        opts?.max_children ?? null,
        opts?.timeout_ms ?? null,
        opts?.remove_on_complete ?? false,
        opts?.remove_on_fail ?? false,
        opts?.idempotency_key ?? null,
        opts?.quiet_hours ?? null,
        opts?.stagger_key ?? null,
      ];
      if (hasMaxStalled) params.push(clampedMaxStalled);

      const inserted = await tx.executeRaw<Record<string, unknown>>(insertSql, params);

      // ON CONFLICT DO NOTHING returns 0 rows — fall back to SELECT to fetch the
      // existing row that won the race.
      if (inserted.length === 0 && opts?.idempotency_key) {
        const existing = await tx.executeRaw<Record<string, unknown>>(
          `SELECT * FROM minion_jobs WHERE idempotency_key = $1`,
          [opts.idempotency_key]
        );
        if (existing.length === 0) {
          throw new Error(`idempotency_key ${opts.idempotency_key} insert returned no row and no existing row found`);
        }
        return rowToMinionJob(existing[0]);
      }

      const child = rowToMinionJob(inserted[0]);

      // 4. Flip parent to waiting-children if this is a fresh child insert.
      //    Only transition from non-terminal, non-already-waiting-children states.
      if (opts?.parent_job_id) {
        await tx.executeRaw(
          `UPDATE minion_jobs SET status = 'waiting-children', updated_at = now()
           WHERE id = $1 AND status IN ('waiting','active','delayed')`,
          [opts.parent_job_id]
        );
      }

      return child;
    });
  }

  /** Get a job by ID. Returns null if not found. */
  async getJob(id: number): Promise<MinionJob | null> {
    const rows = await this.engine.executeRaw<Record<string, unknown>>(
      'SELECT * FROM minion_jobs WHERE id = $1',
      [id]
    );
    return rows.length > 0 ? rowToMinionJob(rows[0]) : null;
  }

  /** List jobs with optional filters. */
  async getJobs(opts?: {
    status?: MinionJobStatus;
    queue?: string;
    name?: string;
    limit?: number;
    offset?: number;
  }): Promise<MinionJob[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (opts?.status) {
      conditions.push(`status = $${idx++}`);
      params.push(opts.status);
    }
    if (opts?.queue) {
      conditions.push(`queue = $${idx++}`);
      params.push(opts.queue);
    }
    if (opts?.name) {
      conditions.push(`name = $${idx++}`);
      params.push(opts.name);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = opts?.limit ?? 50;
    const offset = opts?.offset ?? 0;

    const rows = await this.engine.executeRaw<Record<string, unknown>>(
      `SELECT * FROM minion_jobs ${where} ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx}`,
      [...params, limit, offset]
    );
    return rows.map(rowToMinionJob);
  }

  /** Remove a job. Only terminal statuses can be removed. */
  async removeJob(id: number): Promise<boolean> {
    const rows = await this.engine.executeRaw<Record<string, unknown>>(
      `DELETE FROM minion_jobs WHERE id = $1 AND status IN ('completed', 'dead', 'cancelled', 'failed') RETURNING id`,
      [id]
    );
    return rows.length > 0;
  }

  /**
   * Cancel a job and cascade-kill all descendants in one statement.
   *
   * Honest scope: this is BullMQ-style best-effort cancel. The recursive CTE
   * snapshots the parent_job_id chain at statement start. A descendant
   * re-parented BEFORE the cancel call is excluded; one re-parented DURING
   * the call may still get cancelled (cancel wins if seen in the snapshot).
   * Re-parented descendants whose parent_job_id is NULL'd by
   * removeChildDependency naturally fall out of the recursive walk.
   *
   * Active descendants get lock_token = NULL — same path pause uses, so the
   * worker's renewLock will fail next tick and AbortController fires.
   *
   * Returns the *root* (the job matching id), not an arbitrary descendant.
   */
  async cancelJob(id: number): Promise<MinionJob | null> {
    return this.engine.transaction(async (tx) => {
      const rows = await tx.executeRaw<Record<string, unknown>>(
        `WITH RECURSIVE descendants AS (
          SELECT id, 0 AS d FROM minion_jobs WHERE id = $1
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
          finished_at = now(),
          updated_at = now()
         WHERE id IN (SELECT id FROM descendants)
           AND status IN ('waiting','active','delayed','waiting-children','paused')
         RETURNING *`,
        [id]
      );
      if (rows.length === 0) return null;

      // v0.15: emit child_done(outcome='cancelled') for every cancelled row
      // that had a parent. Without this, an aggregator waiting for N
      // child_done messages hangs forever when a child is cancelled (codex
      // iteration 3). Also unblock any aggregator parents whose last
      // non-terminal child we just cancelled.
      const parentIds = new Set<number>();
      for (const r of rows) {
        const childId = r.id as number;
        const parentJobId = r.parent_job_id as number | null;
        const name = r.name as string;
        // Skip the root if it's the caller's cancel target AND has no parent.
        // Descendants whose parent got cancelled in the same sweep still
        // benefit from the inbox message — their parent exits waiting-children
        // via the resolve sweep below even though the parent is itself
        // cancelled (EXISTS guard on inbox INSERT handles it).
        if (parentJobId == null) continue;
        parentIds.add(parentJobId);
        const childDone: ChildDoneMessage = {
          type: 'child_done',
          child_id: childId,
          job_name: name,
          result: null,
          outcome: 'cancelled',
          error: 'cancelled',
        };
        await tx.executeRaw(
          `INSERT INTO minion_inbox (job_id, sender, payload)
           SELECT $1, 'minions', $2::jsonb
           WHERE EXISTS (
             SELECT 1 FROM minion_jobs
             WHERE id = $1 AND status NOT IN ('completed','failed','dead','cancelled')
           )`,
          [parentJobId, childDone]
        );
      }

      // Resolve any non-cancelled aggregator parents sitting on
      // waiting-children whose last open child we just cancelled.
      for (const parentId of parentIds) {
        await tx.executeRaw(
          `UPDATE minion_jobs SET status = 'waiting', updated_at = now()
           WHERE id = $1 AND status = 'waiting-children'
             AND NOT EXISTS (
               SELECT 1 FROM minion_jobs
               WHERE parent_job_id = $1
                 AND status NOT IN ('completed', 'failed', 'dead', 'cancelled')
             )`,
          [parentId]
        );
      }

      const root = rows.find(r => (r.id as number) === id);
      return root ? rowToMinionJob(root) : null;
    });
  }

  /** Re-queue a failed or dead job for retry. */
  async retryJob(id: number): Promise<MinionJob | null> {
    const rows = await this.engine.executeRaw<Record<string, unknown>>(
      `UPDATE minion_jobs SET status = 'waiting', error_text = NULL,
        lock_token = NULL, lock_until = NULL, delay_until = NULL,
        finished_at = NULL, updated_at = now()
       WHERE id = $1 AND status IN ('failed', 'dead')
       RETURNING *`,
      [id]
    );
    return rows.length > 0 ? rowToMinionJob(rows[0]) : null;
  }

  /** Prune old jobs in terminal statuses. Returns count of deleted rows. */
  async prune(opts?: { olderThan?: Date; status?: MinionJobStatus[] }): Promise<number> {
    const statuses = opts?.status ?? ['completed', 'dead', 'cancelled'];
    const olderThan = opts?.olderThan ?? new Date(Date.now() - 30 * 86400000);

    const rows = await this.engine.executeRaw<{ count: string }>(
      `WITH pruned AS (
         DELETE FROM minion_jobs
         WHERE status = ANY($1) AND updated_at < $2
         RETURNING id
       )
       SELECT count(*)::text as count FROM pruned`,
      [statuses, olderThan.toISOString()]
    );
    return parseInt(rows[0]?.count ?? '0', 10);
  }

  /** Get job statistics. */
  async getStats(opts?: { since?: Date }): Promise<{
    by_status: Record<string, number>;
    by_type: Array<{ name: string; total: number; completed: number; failed: number; dead: number; avg_duration_ms: number | null }>;
    queue_health: { waiting: number; active: number; stalled: number };
  }> {
    const since = opts?.since ?? new Date(Date.now() - 86400000);

    // Status counts
    const statusRows = await this.engine.executeRaw<{ status: string; count: string }>(
      `SELECT status, count(*)::text as count FROM minion_jobs GROUP BY status`
    );
    const by_status: Record<string, number> = {};
    for (const r of statusRows) by_status[r.status] = parseInt(r.count, 10);

    // Type breakdown (within time window)
    const typeRows = await this.engine.executeRaw<Record<string, unknown>>(
      `SELECT name,
        count(*)::text as total,
        count(*) FILTER (WHERE status = 'completed')::text as completed,
        count(*) FILTER (WHERE status = 'failed')::text as failed,
        count(*) FILTER (WHERE status = 'dead')::text as dead,
        avg(EXTRACT(EPOCH FROM (finished_at - started_at)) * 1000) FILTER (WHERE finished_at IS NOT NULL AND started_at IS NOT NULL) as avg_duration_ms
       FROM minion_jobs WHERE created_at >= $1
       GROUP BY name ORDER BY total DESC`,
      [since.toISOString()]
    );
    const by_type = typeRows.map(r => ({
      name: r.name as string,
      total: parseInt(r.total as string, 10),
      completed: parseInt(r.completed as string, 10),
      failed: parseInt(r.failed as string, 10),
      dead: parseInt(r.dead as string, 10),
      avg_duration_ms: r.avg_duration_ms != null ? Math.round(r.avg_duration_ms as number) : null,
    }));

    // Queue health: stalled = active with expired lock
    const stalledRows = await this.engine.executeRaw<{ count: string }>(
      `SELECT count(*)::text as count FROM minion_jobs WHERE status = 'active' AND lock_until < now()`
    );
    const stalled = parseInt(stalledRows[0]?.count ?? '0', 10);

    return {
      by_status,
      by_type,
      queue_health: {
        waiting: by_status['waiting'] ?? 0,
        active: by_status['active'] ?? 0,
        stalled,
      },
    };
  }

  /**
   * Claim the next waiting job for a worker. Token-fenced, filters by registered names.
   *
   * Sets timeout_at = now() + timeout_ms when the job has a per-job deadline,
   * so handleTimeouts() can dead-letter expired jobs without rereading timeout_ms.
   */
  async claim(lockToken: string, lockDurationMs: number, queue: string, registeredNames: string[]): Promise<MinionJob | null> {
    if (registeredNames.length === 0) return null;

    const rows = await this.engine.executeRaw<Record<string, unknown>>(
      `UPDATE minion_jobs SET
        status = 'active',
        lock_token = $1,
        lock_until = now() + ($2::double precision * interval '1 millisecond'),
        timeout_at = CASE WHEN timeout_ms IS NOT NULL
                          THEN now() + (timeout_ms::double precision * interval '1 millisecond')
                          ELSE NULL END,
        attempts_started = attempts_started + 1,
        started_at = COALESCE(started_at, now()),
        updated_at = now()
       WHERE id = (
         SELECT id FROM minion_jobs
         WHERE queue = $3 AND status = 'waiting' AND name = ANY($4)
         ORDER BY priority ASC, created_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       RETURNING *`,
      [lockToken, lockDurationMs, queue, registeredNames]
    );
    return rows.length > 0 ? rowToMinionJob(rows[0]) : null;
  }

  /**
   * Dead-letter active jobs whose timeout_at has passed.
   *
   * The lock_until > now() guard is critical: a stalled job (lock_until < now)
   * is being requeued by handleStalled, NOT timed out terminally. Stall →
   * retry, timeout → dead. Order in worker loop: handleStalled() before
   * handleTimeouts() to give stall recovery first crack.
   *
   * Honest scope: 1-tick TOCTOU window remains. A job whose lock_until
   * expires between handleStalled and handleTimeouts may miss this tick
   * but will be caught the next one (after re-claim). Never double-handled.
   */
  async handleTimeouts(): Promise<MinionJob[]> {
    return this.engine.transaction(async (tx) => {
      const rows = await tx.executeRaw<Record<string, unknown>>(
        `UPDATE minion_jobs SET
          status = 'dead',
          error_text = 'timeout exceeded',
          lock_token = NULL,
          lock_until = NULL,
          finished_at = now(),
          updated_at = now()
         WHERE status = 'active'
           AND timeout_at IS NOT NULL
           AND timeout_at < now()
           AND lock_until > now()
         RETURNING *`
      );

      // v0.15: emit child_done(outcome='timeout') for every timed-out job that
      // had a parent. Without this, an aggregator waiting for N child_done
      // messages hangs forever when a child times out (codex iteration 3).
      // Outcome 'timeout' is distinct from 'dead' so consumers can distinguish
      // "timed out during run" from "died via max-stall".
      const parentIds = new Set<number>();
      for (const r of rows) {
        const parentJobId = r.parent_job_id as number | null;
        if (parentJobId == null) continue;
        parentIds.add(parentJobId);
        const childDone: ChildDoneMessage = {
          type: 'child_done',
          child_id: r.id as number,
          job_name: r.name as string,
          result: null,
          outcome: 'timeout',
          error: 'timeout exceeded',
        };
        await tx.executeRaw(
          `INSERT INTO minion_inbox (job_id, sender, payload)
           SELECT $1, 'minions', $2::jsonb
           WHERE EXISTS (
             SELECT 1 FROM minion_jobs
             WHERE id = $1 AND status NOT IN ('completed','failed','dead','cancelled')
           )`,
          [parentJobId, childDone]
        );
      }

      // Unblock any aggregator parents whose last open child we just killed.
      for (const parentId of parentIds) {
        await tx.executeRaw(
          `UPDATE minion_jobs SET status = 'waiting', updated_at = now()
           WHERE id = $1 AND status = 'waiting-children'
             AND NOT EXISTS (
               SELECT 1 FROM minion_jobs
               WHERE parent_job_id = $1
                 AND status NOT IN ('completed', 'failed', 'dead', 'cancelled')
             )`,
          [parentId]
        );
      }

      return rows.map(rowToMinionJob);
    });
  }

  /**
   * Dead-letter active jobs that exceed a wall-clock runtime threshold,
   * regardless of lock state. This catches jobs stuck while still holding
   * DB resources (e.g. blocked on file locks) where stall sweeps skip rows.
   *
   * Threshold (ms):
   *   timeout_ms set   -> timeout_ms * 2
   *   timeout_ms null  -> 2 * lockDurationMs * max_stalled
   */
  async handleWallClockTimeouts(lockDurationMs: number): Promise<MinionJob[]> {
    return this.engine.transaction(async (tx) => {
      const rows = await tx.executeRaw<Record<string, unknown>>(
        `UPDATE minion_jobs SET
          status = 'dead',
          error_text = 'wall-clock timeout exceeded',
          lock_token = NULL,
          lock_until = NULL,
          finished_at = now(),
          updated_at = now()
         WHERE status = 'active'
           AND started_at IS NOT NULL
           AND EXTRACT(EPOCH FROM (now() - started_at)) * 1000 >
             CASE
               WHEN timeout_ms IS NOT NULL THEN timeout_ms * 2
               ELSE $1::double precision * 2 * GREATEST(max_stalled, 1)
             END
         RETURNING *`,
        [lockDurationMs]
      );

      const parentIds = new Set<number>();
      for (const r of rows) {
        const parentJobId = r.parent_job_id as number | null;
        if (parentJobId == null) continue;
        parentIds.add(parentJobId);
        const childDone: ChildDoneMessage = {
          type: 'child_done',
          child_id: r.id as number,
          job_name: r.name as string,
          result: null,
          outcome: 'timeout',
          error: 'wall-clock timeout exceeded',
        };
        await tx.executeRaw(
          `INSERT INTO minion_inbox (job_id, sender, payload)
           SELECT $1, 'minions', $2::jsonb
           WHERE EXISTS (
             SELECT 1 FROM minion_jobs
             WHERE id = $1 AND status NOT IN ('completed','failed','dead','cancelled')
           )`,
          [parentJobId, childDone]
        );
      }

      for (const parentId of parentIds) {
        await tx.executeRaw(
          `UPDATE minion_jobs SET status = 'waiting', updated_at = now()
           WHERE id = $1 AND status = 'waiting-children'
             AND NOT EXISTS (
               SELECT 1 FROM minion_jobs
               WHERE parent_job_id = $1
                 AND status NOT IN ('completed', 'failed', 'dead', 'cancelled')
             )`,
          [parentId]
        );
      }

      return rows.map(rowToMinionJob);
    });
  }

  /**
   * Complete a job (token-fenced). All side effects atomic in one transaction:
   *   1. UPDATE child to 'completed' with result
   *   2. Roll up token counts to parent (skipped if parent is terminal)
   *   3. Insert child_done message into parent's inbox (skipped if parent terminal)
   *   4. Resolve parent (flip waiting-children → waiting if all kids done)
   *   5. If remove_on_complete, DELETE the child row (cascades inbox + attachments)
   *
   * Returns the completed job (the in-memory snapshot before any delete), or
   * null if the lock_token mismatched (e.g., reclaimed mid-completion).
   *
   * The fold-in of resolveParent eliminates the crash window where a process
   * died between completeJob and worker's prior post-call resolveParent,
   * stranding the parent in waiting-children forever.
   */
  async completeJob(id: number, lockToken: string, result?: Record<string, unknown>): Promise<MinionJob | null> {
    return this.engine.transaction(async (tx) => {
      // Peek at parent_job_id before the UPDATE so we can lock the parent row
      // FIRST. Without this SELECT FOR UPDATE, two siblings completing
      // concurrently each see the other as still active (pre-commit snapshot
      // under read-committed), neither flips the parent, and the parent is
      // stuck in waiting-children forever.
      const peek = await tx.executeRaw<{ parent_job_id: number | null }>(
        `SELECT parent_job_id FROM minion_jobs WHERE id = $1`,
        [id]
      );
      const parentId = peek[0]?.parent_job_id ?? null;
      if (parentId) {
        await tx.executeRaw(
          `SELECT id FROM minion_jobs WHERE id = $1 FOR UPDATE`,
          [parentId]
        );
      }

      const rows = await tx.executeRaw<Record<string, unknown>>(
        `UPDATE minion_jobs SET status = 'completed', result = $1::jsonb,
          finished_at = now(), lock_token = NULL, lock_until = NULL, updated_at = now()
         WHERE id = $2 AND status = 'active' AND lock_token = $3
         RETURNING *`,
        [result ?? null, id, lockToken]
      );
      if (rows.length === 0) return null;

      const completed = rowToMinionJob(rows[0]);

      if (completed.parent_job_id) {
        // Roll up token counts. Guarded against parent already being terminal.
        if (completed.tokens_input > 0 || completed.tokens_output > 0 || completed.tokens_cache_read > 0) {
          await tx.executeRaw(
            `UPDATE minion_jobs SET
              tokens_input = tokens_input + $1,
              tokens_output = tokens_output + $2,
              tokens_cache_read = tokens_cache_read + $3,
              updated_at = now()
             WHERE id = $4 AND status NOT IN ('completed', 'failed', 'dead', 'cancelled')`,
            [completed.tokens_input, completed.tokens_output, completed.tokens_cache_read, completed.parent_job_id]
          );
        }

        // Auto-post child_done into parent's inbox. EXISTS guard skips if parent
        // was deleted or hit a terminal state mid-flight (no FK violation, no
        // contradiction with the token rollup guard).
        const childDone: ChildDoneMessage = {
          type: 'child_done',
          child_id: completed.id,
          job_name: completed.name,
          result: result ?? null,
          outcome: 'complete',
        };
        await tx.executeRaw(
          `INSERT INTO minion_inbox (job_id, sender, payload)
           SELECT $1, 'minions', $2::jsonb
           WHERE EXISTS (
             SELECT 1 FROM minion_jobs
             WHERE id = $1 AND status NOT IN ('completed','failed','dead','cancelled')
           )`,
          [completed.parent_job_id, childDone]
        );

        // Fold-in resolveParent: flip parent to waiting once all children are
        // in ANY terminal state. Terminal set includes 'failed' so a failed
        // child with on_child_fail='continue'/'ignore' doesn't strand the
        // parent in waiting-children forever (v0.15 aggregator fix).
        await tx.executeRaw(
          `UPDATE minion_jobs SET status = 'waiting', updated_at = now()
           WHERE id = $1 AND status = 'waiting-children'
             AND NOT EXISTS (
               SELECT 1 FROM minion_jobs
               WHERE parent_job_id = $1
                 AND status NOT IN ('completed', 'failed', 'dead', 'cancelled')
             )`,
          [completed.parent_job_id]
        );
      }

      // remove_on_complete cleanup AFTER all parent-side bookkeeping.
      // The child_done we just inserted lives in the *parent's* inbox row,
      // so it survives the child cascade-delete.
      if (completed.remove_on_complete) {
        await tx.executeRaw(
          `DELETE FROM minion_jobs WHERE id = $1`,
          [completed.id]
        );
      }

      return completed;
    });
  }

  /**
   * Fail a job (token-fenced). All side effects atomic in one transaction:
   *   1. UPDATE child to 'delayed' (retry) | 'failed' | 'dead'
   *   2. If terminal AND parent_job_id, run on_child_fail policy:
   *      - 'fail_parent' → mark parent 'failed' (via failParent SQL)
   *      - 'remove_dep'  → null out parent_job_id (via removeChildDependency SQL)
   *      - 'ignore' / 'continue' → no parent action
   *   3. If remove_on_fail AND terminal, DELETE the child row (parent hook
   *      already ran in this txn using in-memory state, so child deletion is safe)
   *
   * Folding the parent hook into this transaction eliminates the crash window
   * where a process died between failJob and worker's prior post-call hook,
   * leaving the parent stuck in waiting-children.
   */
  async failJob(
    id: number,
    lockToken: string,
    errorText: string,
    newStatus: 'delayed' | 'failed' | 'dead',
    backoffMs?: number
  ): Promise<MinionJob | null> {
    return this.engine.transaction(async (tx) => {
      // Lock the parent row first so concurrent sibling completions/failures
      // serialize on the parent — same race fix as completeJob.
      const peek = await tx.executeRaw<{ parent_job_id: number | null }>(
        `SELECT parent_job_id FROM minion_jobs WHERE id = $1`,
        [id]
      );
      const parentId = peek[0]?.parent_job_id ?? null;
      if (parentId) {
        await tx.executeRaw(
          `SELECT id FROM minion_jobs WHERE id = $1 FOR UPDATE`,
          [parentId]
        );
      }

      const rows = await tx.executeRaw<Record<string, unknown>>(
        `UPDATE minion_jobs SET
          status = $1, error_text = $2, attempts_made = attempts_made + 1,
          stacktrace = COALESCE(stacktrace, '[]'::jsonb) || to_jsonb($3::text),
          delay_until = CASE WHEN $1 = 'delayed' THEN now() + ($4::double precision * interval '1 millisecond') ELSE NULL END,
          finished_at = CASE WHEN $1 IN ('failed', 'dead') THEN now() ELSE NULL END,
          lock_token = NULL, lock_until = NULL, updated_at = now()
         WHERE id = $5 AND status = 'active' AND lock_token = $6
         RETURNING *`,
        [newStatus, errorText, errorText, backoffMs ?? 0, id, lockToken]
      );
      if (rows.length === 0) return null;

      const failed = rowToMinionJob(rows[0]);
      const terminal = newStatus === 'failed' || newStatus === 'dead';

      // Parent hook on terminal failure.
      if (terminal && failed.parent_job_id) {
        // v0.15: emit child_done(outcome='failed') BEFORE any parent-terminal
        // update. Insertion order matters because `completeJob`'s inbox-write
        // EXISTS guard skips writes once the parent is 'failed' — if we let
        // the fail_parent UPDATE run first, this inbox row would be dropped
        // for aggregator-style parents that still want to count it (codex).
        const childDone: ChildDoneMessage = {
          type: 'child_done',
          child_id: failed.id,
          job_name: failed.name,
          result: null,
          outcome: newStatus === 'dead' ? 'dead' : 'failed',
          error: errorText,
        };
        await tx.executeRaw(
          `INSERT INTO minion_inbox (job_id, sender, payload)
           SELECT $1, 'minions', $2::jsonb
           WHERE EXISTS (
             SELECT 1 FROM minion_jobs
             WHERE id = $1 AND status NOT IN ('completed','failed','dead','cancelled')
           )`,
          [failed.parent_job_id, childDone]
        );

        if (failed.on_child_fail === 'fail_parent') {
          await tx.executeRaw(
            `UPDATE minion_jobs SET status = 'failed',
              error_text = $1, finished_at = now(), updated_at = now()
             WHERE id = $2 AND status = 'waiting-children'`,
            [`child job ${failed.id} failed: ${errorText}`, failed.parent_job_id]
          );
        } else if (failed.on_child_fail === 'remove_dep') {
          await tx.executeRaw(
            `UPDATE minion_jobs SET parent_job_id = NULL, updated_at = now() WHERE id = $1`,
            [failed.id]
          );
          // After dropping the dep, try to resolve the parent if all OTHER
          // kids are terminal. Terminal set includes 'failed' (v0.15).
          await tx.executeRaw(
            `UPDATE minion_jobs SET status = 'waiting', updated_at = now()
             WHERE id = $1 AND status = 'waiting-children'
               AND NOT EXISTS (
                 SELECT 1 FROM minion_jobs
                 WHERE parent_job_id = $1
                   AND status NOT IN ('completed', 'failed', 'dead', 'cancelled')
               )`,
            [failed.parent_job_id]
          );
        } else {
          // 'ignore' / 'continue': parent stays in waiting-children waiting on
          // siblings. With v0.15 terminal-set expansion + child_done emission
          // above, an aggregator sibling-count model now works: all N children
          // reach terminal → completeJob on a sibling (or the LAST terminal
          // transition here) flips parent → waiting once no non-terminal kids
          // remain. Run the resolve check here so the last child transitioning
          // via THIS code path still unblocks the parent.
          await tx.executeRaw(
            `UPDATE minion_jobs SET status = 'waiting', updated_at = now()
             WHERE id = $1 AND status = 'waiting-children'
               AND NOT EXISTS (
                 SELECT 1 FROM minion_jobs
                 WHERE parent_job_id = $1
                   AND status NOT IN ('completed', 'failed', 'dead', 'cancelled')
               )`,
            [failed.parent_job_id]
          );
        }
      }

      // remove_on_fail cleanup AFTER parent hook.
      if (terminal && failed.remove_on_fail) {
        await tx.executeRaw(
          `DELETE FROM minion_jobs WHERE id = $1`,
          [failed.id]
        );
      }

      return failed;
    });
  }

  /** Update job progress (token-fenced). */
  async updateProgress(id: number, lockToken: string, progress: unknown): Promise<boolean> {
    const rows = await this.engine.executeRaw<Record<string, unknown>>(
      `UPDATE minion_jobs SET progress = $1::jsonb, updated_at = now()
       WHERE id = $2 AND status = 'active' AND lock_token = $3
       RETURNING id`,
      [progress, id, lockToken]
    );
    return rows.length > 0;
  }

  /** Renew lock (token-fenced). Returns false if token mismatch (job was reclaimed). */
  async renewLock(id: number, lockToken: string, lockDurationMs: number): Promise<boolean> {
    const rows = await this.engine.executeRaw<Record<string, unknown>>(
      `UPDATE minion_jobs SET lock_until = now() + ($1::double precision * interval '1 millisecond'), updated_at = now()
       WHERE id = $2 AND lock_token = $3 AND status = 'active'
       RETURNING id`,
      [lockDurationMs, id, lockToken]
    );
    return rows.length > 0;
  }

  /** Promote delayed jobs whose delay_until has passed. Returns promoted jobs. */
  async promoteDelayed(): Promise<MinionJob[]> {
    const rows = await this.engine.executeRaw<Record<string, unknown>>(
      `UPDATE minion_jobs SET status = 'waiting', delay_until = NULL,
        lock_token = NULL, lock_until = NULL, updated_at = now()
       WHERE status = 'delayed' AND delay_until <= now()
       RETURNING *`
    );
    return rows.map(rowToMinionJob);
  }

  /** Detect and handle stalled jobs. Single CTE, no off-by-one. Returns affected jobs. */
  async handleStalled(): Promise<{ requeued: MinionJob[]; dead: MinionJob[] }> {
    const rows = await this.engine.executeRaw<Record<string, unknown> & { action: string }>(
      `WITH stalled AS (
        SELECT id, stalled_counter, max_stalled
        FROM minion_jobs
        WHERE status = 'active' AND lock_until < now()
        FOR UPDATE SKIP LOCKED
      ),
      requeued AS (
        UPDATE minion_jobs SET
          status = 'waiting', stalled_counter = stalled_counter + 1,
          lock_token = NULL, lock_until = NULL, updated_at = now()
        WHERE id IN (SELECT id FROM stalled WHERE stalled_counter + 1 < max_stalled)
        RETURNING *, 'requeued' as action
      ),
      dead_lettered AS (
        UPDATE minion_jobs SET
          status = 'dead', stalled_counter = stalled_counter + 1,
          error_text = 'max stalled count exceeded',
          lock_token = NULL, lock_until = NULL, finished_at = now(), updated_at = now()
        WHERE id IN (SELECT id FROM stalled WHERE stalled_counter + 1 >= max_stalled)
        RETURNING *, 'dead' as action
      )
      SELECT * FROM requeued UNION ALL SELECT * FROM dead_lettered`
    );

    const requeued: MinionJob[] = [];
    const dead: MinionJob[] = [];
    for (const r of rows) {
      const job = rowToMinionJob(r);
      if (r.action === 'requeued') requeued.push(job);
      else dead.push(job);
    }
    return { requeued, dead };
  }

  /**
   * Check if all children of a parent are in ANY terminal state. If so,
   * unblock parent (flip waiting-children → waiting).
   *
   * v0.15: terminal set includes 'failed' so a child failing with
   * on_child_fail='continue'/'ignore' doesn't strand the parent.
   */
  async resolveParent(parentId: number): Promise<MinionJob | null> {
    const rows = await this.engine.executeRaw<Record<string, unknown>>(
      `UPDATE minion_jobs SET status = 'waiting', updated_at = now()
       WHERE id = $1 AND status = 'waiting-children'
         AND NOT EXISTS (
           SELECT 1 FROM minion_jobs
           WHERE parent_job_id = $1
             AND status NOT IN ('completed', 'failed', 'dead', 'cancelled')
         )
       RETURNING *`,
      [parentId]
    );
    return rows.length > 0 ? rowToMinionJob(rows[0]) : null;
  }

  /** Fail the parent when a child fails with fail_parent policy. */
  async failParent(parentId: number, childId: number, errorText: string): Promise<MinionJob | null> {
    const rows = await this.engine.executeRaw<Record<string, unknown>>(
      `UPDATE minion_jobs SET status = 'failed',
        error_text = $1, finished_at = now(), updated_at = now()
       WHERE id = $2 AND status = 'waiting-children'
       RETURNING *`,
      [`child job ${childId} failed: ${errorText}`, parentId]
    );
    return rows.length > 0 ? rowToMinionJob(rows[0]) : null;
  }

  /** Pause a waiting or active job. For active jobs, clears the lock so the worker's
   *  AbortController fires and the handler stops gracefully. */
  async pauseJob(id: number): Promise<MinionJob | null> {
    const rows = await this.engine.executeRaw<Record<string, unknown>>(
      `UPDATE minion_jobs SET status = 'paused',
        lock_token = NULL, lock_until = NULL, updated_at = now()
       WHERE id = $1 AND status IN ('waiting', 'active', 'delayed')
       RETURNING *`,
      [id]
    );
    return rows.length > 0 ? rowToMinionJob(rows[0]) : null;
  }

  /** Resume a paused job back to waiting. */
  async resumeJob(id: number): Promise<MinionJob | null> {
    const rows = await this.engine.executeRaw<Record<string, unknown>>(
      `UPDATE minion_jobs SET status = 'waiting',
        lock_token = NULL, lock_until = NULL, updated_at = now()
       WHERE id = $1 AND status = 'paused'
       RETURNING *`,
      [id]
    );
    return rows.length > 0 ? rowToMinionJob(rows[0]) : null;
  }

  /** Send a message to a job's inbox. Sender must be the parent job or 'admin'. */
  async sendMessage(jobId: number, payload: unknown, sender: string): Promise<InboxMessage | null> {
    // Validate job exists and is in a messageable state
    const job = await this.getJob(jobId);
    if (!job) return null;
    if (['completed', 'dead', 'cancelled', 'failed'].includes(job.status)) return null;

    // Sender validation: must be parent job ID or 'admin'
    if (sender !== 'admin' && sender !== String(job.parent_job_id)) {
      return null;
    }

    const rows = await this.engine.executeRaw<Record<string, unknown>>(
      `INSERT INTO minion_inbox (job_id, sender, payload)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [jobId, sender, payload]
    );
    return rows.length > 0 ? rowToInboxMessage(rows[0]) : null;
  }

  /** Read unread inbox messages for a job. Token-fenced. Marks messages as read. */
  async readInbox(jobId: number, lockToken: string): Promise<InboxMessage[]> {
    // Verify lock ownership
    const lockCheck = await this.engine.executeRaw<{ id: number }>(
      `SELECT id FROM minion_jobs WHERE id = $1 AND lock_token = $2 AND status = 'active'`,
      [jobId, lockToken]
    );
    if (lockCheck.length === 0) return [];

    const rows = await this.engine.executeRaw<Record<string, unknown>>(
      `UPDATE minion_inbox SET read_at = now()
       WHERE job_id = $1 AND read_at IS NULL
       RETURNING *`,
      [jobId]
    );
    return rows.map(rowToInboxMessage);
  }

  /** Update token counts for a job. Accumulates (adds to existing). Token-fenced. */
  async updateTokens(id: number, lockToken: string, tokens: TokenUpdate): Promise<boolean> {
    const rows = await this.engine.executeRaw<Record<string, unknown>>(
      `UPDATE minion_jobs SET
        tokens_input = tokens_input + $1,
        tokens_output = tokens_output + $2,
        tokens_cache_read = tokens_cache_read + $3,
        updated_at = now()
       WHERE id = $4 AND status = 'active' AND lock_token = $5
       RETURNING id`,
      [tokens.input ?? 0, tokens.output ?? 0, tokens.cache_read ?? 0, id, lockToken]
    );
    return rows.length > 0;
  }

  /** Replay a completed/failed/dead job with optional data overrides. Creates a new job. */
  async replayJob(id: number, dataOverrides?: Record<string, unknown>): Promise<MinionJob | null> {
    const source = await this.getJob(id);
    if (!source) return null;
    if (!['completed', 'failed', 'dead'].includes(source.status)) return null;

    const data = dataOverrides
      ? { ...source.data, ...dataOverrides }
      : source.data;

    return this.add(source.name, data, {
      queue: source.queue,
      priority: source.priority,
      max_attempts: source.max_attempts,
      backoff_type: source.backoff_type,
      backoff_delay: source.backoff_delay,
      backoff_jitter: source.backoff_jitter,
    });
  }

  /** Remove a child's dependency on its parent. */
  async removeChildDependency(childId: number): Promise<void> {
    await this.engine.executeRaw(
      `UPDATE minion_jobs SET parent_job_id = NULL, updated_at = now() WHERE id = $1`,
      [childId]
    );
  }

  /**
   * Read child_done messages from a parent's inbox. Token-fenced (the parent
   * job must currently hold lockToken — same fence as readInbox to prevent a
   * stale process polling completions for jobs it no longer owns).
   *
   * Does NOT mark messages read (parent may want to poll repeatedly with a
   * cursor). Use `since` to fetch only newer entries.
   */
  async readChildCompletions(
    parentId: number,
    lockToken: string,
    opts?: { since?: Date }
  ): Promise<ChildDoneMessage[]> {
    // Verify the caller holds the parent's lock.
    const lockCheck = await this.engine.executeRaw<{ id: number }>(
      `SELECT id FROM minion_jobs WHERE id = $1 AND lock_token = $2 AND status = 'active'`,
      [parentId, lockToken]
    );
    if (lockCheck.length === 0) return [];

    const params: unknown[] = [parentId];
    let sinceClause = '';
    if (opts?.since) {
      sinceClause = ` AND sent_at > $2::timestamptz`;
      params.push(opts.since.toISOString());
    }

    const rows = await this.engine.executeRaw<Record<string, unknown>>(
      `SELECT payload FROM minion_inbox
       WHERE job_id = $1 AND (payload->>'type') = 'child_done'${sinceClause}
       ORDER BY sent_at ASC`,
      params
    );

    return rows.map(r => {
      const p = typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload;
      return p as ChildDoneMessage;
    });
  }

  /**
   * Attach a file to a job. Validates size, base64, filename safety, and
   * duplicate filename. Returns the persisted attachment metadata (not the
   * bytes — use getAttachment to fetch).
   *
   * The DB UNIQUE (job_id, filename) constraint is the authoritative duplicate
   * fence; the in-memory check just gives a faster error.
   */
  async addAttachment(jobId: number, input: AttachmentInput): Promise<Attachment> {
    await this.ensureSchema();

    // Verify job exists (FK guarantees this on insert too, but explicit error is clearer)
    const exists = await this.engine.executeRaw<{ id: number }>(
      `SELECT id FROM minion_jobs WHERE id = $1`,
      [jobId]
    );
    if (exists.length === 0) {
      throw new Error(`job ${jobId} not found`);
    }

    const existingRows = await this.engine.executeRaw<{ filename: string }>(
      `SELECT filename FROM minion_attachments WHERE job_id = $1`,
      [jobId]
    );
    const existingFilenames = new Set(existingRows.map(r => r.filename));

    const result = validateAttachment(input, {
      maxBytes: this.maxAttachmentBytes,
      existingFilenames,
    });
    if (!result.ok) {
      throw new Error(`attachment validation failed: ${result.error}`);
    }
    const { filename, content_type, bytes, size_bytes, sha256 } = result.normalized;

    const rows = await this.engine.executeRaw<Record<string, unknown>>(
      `INSERT INTO minion_attachments (job_id, filename, content_type, content, size_bytes, sha256)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, job_id, filename, content_type, storage_uri, size_bytes, sha256, created_at`,
      [jobId, filename, content_type, bytes, size_bytes, sha256]
    );
    return rowToAttachment(rows[0]);
  }

  /** List attachments for a job (metadata only, no bytes). */
  async listAttachments(jobId: number): Promise<Attachment[]> {
    const rows = await this.engine.executeRaw<Record<string, unknown>>(
      `SELECT id, job_id, filename, content_type, storage_uri, size_bytes, sha256, created_at
       FROM minion_attachments
       WHERE job_id = $1
       ORDER BY created_at ASC, id ASC`,
      [jobId]
    );
    return rows.map(rowToAttachment);
  }

  /**
   * Fetch a single attachment with bytes. Returns null if not found.
   * The bytes are returned as a Buffer (Uint8Array under the hood).
   */
  async getAttachment(jobId: number, filename: string): Promise<{ meta: Attachment; bytes: Buffer } | null> {
    const rows = await this.engine.executeRaw<Record<string, unknown>>(
      `SELECT id, job_id, filename, content_type, storage_uri, size_bytes, sha256, created_at, content
       FROM minion_attachments
       WHERE job_id = $1 AND filename = $2`,
      [jobId, filename]
    );
    if (rows.length === 0) return null;
    const row = rows[0];
    const meta = rowToAttachment(row);
    const raw = row.content;
    let bytes: Buffer;
    if (raw == null) {
      bytes = Buffer.alloc(0);
    } else if (Buffer.isBuffer(raw)) {
      bytes = raw;
    } else if (raw instanceof Uint8Array) {
      bytes = Buffer.from(raw);
    } else {
      bytes = Buffer.from(raw as ArrayBuffer);
    }
    return { meta, bytes };
  }

  /** Delete an attachment by job + filename. Returns true if a row was removed. */
  async deleteAttachment(jobId: number, filename: string): Promise<boolean> {
    const rows = await this.engine.executeRaw<{ id: number }>(
      `DELETE FROM minion_attachments WHERE job_id = $1 AND filename = $2 RETURNING id`,
      [jobId, filename]
    );
    return rows.length > 0;
  }
}
