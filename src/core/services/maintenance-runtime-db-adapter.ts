import type { BrainEngine } from '../engine.ts';
import {
  addMilliseconds,
  cloneJson,
  type AcquireMaintenanceCycleLockInput,
  type ClaimMaintenanceJobByIdInput,
  type ClaimMaintenanceJobInput,
  type CompleteMaintenanceJobInput,
  type FailMaintenanceJobInput,
  type ForegroundPressureState,
  type MaintenanceCycleLock,
  type MaintenanceFailureClass,
  type MaintenanceJobFilters,
  type RenewMaintenanceJobLeaseInput,
  type ReleaseMaintenanceCycleLockInput,
} from '../maintenance/job-runtime.ts';
import type {
  AcquireMaintenanceCycleLockResult,
  MaintenanceRuntimeStatus,
} from './maintenance-runtime-service.ts';

export interface SqlMaintenanceRuntimeAdapterOptions {
  now?: () => string;
  foregroundPressure?: () => ForegroundPressureState;
}

export interface SqlMaintenanceRuntimeAdapter {
  enqueueJob(input: Record<string, unknown>): Promise<{ status: 'enqueued' | 'deduped' | 'coalesced'; job: Record<string, unknown> }>;
  claimJob(input: ClaimMaintenanceJobByIdInput): Promise<Record<string, unknown> | null>;
  claimNextJob(input: ClaimMaintenanceJobInput): Promise<Record<string, unknown> | null>;
  renewJobLease(input: RenewMaintenanceJobLeaseInput): Promise<Record<string, unknown>>;
  completeJob(input: CompleteMaintenanceJobInput): Promise<Record<string, unknown>>;
  failJob(input: FailMaintenanceJobInput): Promise<Record<string, unknown>>;
  sweepTimedOutJobs(): Promise<Array<Record<string, unknown>>>;
  getJob(id: string): Promise<Record<string, unknown> | null>;
  listJobs(filters?: MaintenanceJobFilters): Promise<Array<Record<string, unknown>>>;
  listJobEvents(jobId: string): Promise<Array<Record<string, unknown>>>;
  listRuntimeEvents(): Promise<Array<Record<string, unknown>>>;
  appendJobLog(input: { job_id: string; level: 'debug' | 'info' | 'warn' | 'error'; message: string; metadata_json?: Record<string, unknown> }): Promise<void>;
  acquireCycleLock(input: AcquireMaintenanceCycleLockInput): Promise<AcquireMaintenanceCycleLockResult>;
  releaseCycleLock(input: ReleaseMaintenanceCycleLockInput): Promise<{ status: 'released' | 'not_found' | 'not_holder' }>;
  recordWorkerHeartbeat(input: { worker_id: string; worker_host: string; worker_pid: number; queues: string[]; metadata_json?: Record<string, unknown> }): Promise<Record<string, unknown>>;
  getStatus(): Promise<MaintenanceRuntimeStatus>;
  listWorkerHeartbeats(): Promise<Array<Record<string, unknown>>>;
  getActiveCycleLock(): Promise<Record<string, unknown> | null>;
  getLastCycleResult(): Promise<Record<string, unknown> | null>;
}

type SqlEngineKind = 'postgres' | 'pglite' | 'sqlite';

interface SqlExecutor {
  kind: SqlEngineKind;
  query(sql: string, params?: unknown[]): Promise<Array<Record<string, unknown>>>;
  exec(sql: string, params?: unknown[]): Promise<void>;
}

export function createSqlMaintenanceRuntimeAdapter(
  engine: BrainEngine,
  options: SqlMaintenanceRuntimeAdapterOptions = {},
): SqlMaintenanceRuntimeAdapter {
  const executor = resolveSqlExecutor(engine);
  const now = options.now ?? (() => new Date().toISOString());

  return {
    async enqueueJob(input) {
      return withRuntimeTransaction(engine, async (tx) => {
        await lockTable(tx, 'memory_jobs');
        const name = stringValue(input.name, 'autopilot_cycle');
        const queue = stringValue(input.queue, 'maintenance');
        const idempotencyKey = optionalString(input.idempotency_key);
        const maxWaiting = numberValue(input.max_waiting, 0);
        const currentNow = now();

        if (idempotencyKey) {
          const existing = await selectOne(tx, `
            SELECT *
            FROM memory_jobs
            WHERE idempotency_key = ${placeholder(tx, 1)}
              AND status NOT IN ('completed', 'failed', 'dead', 'cancelled')
            ORDER BY created_at ASC
            LIMIT 1
          `, [idempotencyKey]);
          if (existing) {
            await insertEvent(tx, {
              id: `job-event:${crypto.randomUUID()}`,
              job_id: String(existing.id),
              event_type: 'submission_deduped',
              metadata_json: { idempotency_key: idempotencyKey },
              created_at: currentNow,
            });
            return { status: 'deduped', job: normalizeRecord(existing) };
          }
        }

        if (maxWaiting > 0) {
          const waiting = await queryRows(tx, `
            SELECT *
            FROM memory_jobs
            WHERE name = ${placeholder(tx, 1)}
              AND status IN ('waiting', 'delayed')
            ORDER BY priority DESC, next_run_at ASC, created_at ASC, id ASC
            LIMIT ${placeholder(tx, 2)}
          `, [name, maxWaiting]);
          if (waiting.length >= maxWaiting && waiting[0]) {
            const job = waiting[0];
            await execSql(tx, `
              UPDATE memory_jobs
              SET payload_json = ${jsonExpr(tx, 1)},
                  idempotency_key = ${placeholder(tx, 2)},
                  updated_at = ${placeholder(tx, 3)}
              WHERE id = ${placeholder(tx, 4)}
            `, [
              input.payload_json ?? {},
              idempotencyKey,
              currentNow,
              job.id,
            ]);
            await insertEvent(tx, {
              id: `job-event:${crypto.randomUUID()}`,
              job_id: String(job.id),
              event_type: 'submission_coalesced',
              metadata_json: { coalesced_idempotency_key: idempotencyKey },
              created_at: currentNow,
            });
            const updated = await selectOne(tx, `
              SELECT *
              FROM memory_jobs
              WHERE id = ${placeholder(tx, 1)}
            `, [job.id]);
            return { status: 'coalesced', job: normalizeRecord(updated ?? job) };
          }
        }

        const job = {
          id: `job:${crypto.randomUUID()}`,
          name,
          queue,
          status: 'waiting',
          priority: numberValue(input.priority, 0),
          payload_json: input.payload_json ?? {},
          result_json: null,
          progress_json: input.progress_json ?? {},
          max_attempts: Math.max(1, numberValue(input.max_attempts, 1)),
          attempts_started: 0,
          attempts_finished: 0,
          backoff_type: stringValue(input.backoff_type, 'none'),
          backoff_delay_ms: Math.max(0, numberValue(input.backoff_delay_ms, 0)),
          lock_token: null,
          lock_owner: null,
          lock_expires_at: null,
          timeout_ms: optionalNumber(input.timeout_ms),
          timeout_at: null,
          idempotency_key: idempotencyKey,
          parent_job_id: optionalString(input.parent_job_id),
          failure_class: null,
          last_error: null,
          next_run_at: currentNow,
          created_at: currentNow,
          started_at: null,
          finished_at: null,
          updated_at: currentNow,
        };
        await execSql(tx, `
          INSERT INTO memory_jobs (
            id, name, queue, status, priority, payload_json, result_json, progress_json,
            max_attempts, attempts_started, attempts_finished, backoff_type, backoff_delay_ms,
            lock_token, lock_owner, lock_expires_at, timeout_ms, timeout_at, idempotency_key,
            parent_job_id, failure_class, last_error, next_run_at, created_at, started_at,
            finished_at, updated_at
          ) VALUES (
            ${placeholder(tx, 1)}, ${placeholder(tx, 2)}, ${placeholder(tx, 3)},
            ${placeholder(tx, 4)}, ${placeholder(tx, 5)}, ${jsonExpr(tx, 6)},
            ${jsonExpr(tx, 7)}, ${jsonExpr(tx, 8)}, ${placeholder(tx, 9)},
            ${placeholder(tx, 10)}, ${placeholder(tx, 11)}, ${placeholder(tx, 12)},
            ${placeholder(tx, 13)}, ${placeholder(tx, 14)}, ${placeholder(tx, 15)},
            ${placeholder(tx, 16)}, ${placeholder(tx, 17)}, ${placeholder(tx, 18)},
            ${placeholder(tx, 19)}, ${placeholder(tx, 20)}, ${placeholder(tx, 21)},
            ${placeholder(tx, 22)}, ${placeholder(tx, 23)}, ${placeholder(tx, 24)},
            ${placeholder(tx, 25)}, ${placeholder(tx, 26)}, ${placeholder(tx, 27)}
          )
        `, [
          job.id,
          job.name,
          job.queue,
          job.status,
          job.priority,
          job.payload_json,
          job.result_json,
          job.progress_json,
          job.max_attempts,
          job.attempts_started,
          job.attempts_finished,
          job.backoff_type,
          job.backoff_delay_ms,
          job.lock_token,
          job.lock_owner,
          job.lock_expires_at,
          job.timeout_ms,
          job.timeout_at,
          job.idempotency_key,
          job.parent_job_id,
          job.failure_class,
          job.last_error,
          job.next_run_at,
          job.created_at,
          job.started_at,
          job.finished_at,
          job.updated_at,
        ]);
        await insertEvent(tx, {
          id: `job-event:${crypto.randomUUID()}`,
          job_id: job.id,
          event_type: 'job_enqueued',
          metadata_json: { idempotency_key: idempotencyKey },
          created_at: currentNow,
        });
        return { status: 'enqueued', job: cloneJson(job) };
      });
    },

    async claimJob(input) {
      return withRuntimeTransaction(engine, async (tx) => {
        const currentNow = now();
        const pressure = options.foregroundPressure?.();
        if (pressure?.active) {
          await insertEvent(tx, {
            id: `job-event:${crypto.randomUUID()}`,
            job_id: null,
            event_type: 'claim_paused_for_foreground_pressure',
            metadata_json: { reason: pressure.reason ?? 'foreground_pressure' },
            created_at: currentNow,
            worker_id: input.worker_id,
          });
          return null;
        }
        const job = await selectJobForUpdate(tx, input.job_id);
        if (
          !job
          || job.queue !== input.queue
          || (input.name !== undefined && job.name !== input.name)
          || !jobCanBeClaimed(job, currentNow)
        ) return null;

        const lockToken = `lock-token:${crypto.randomUUID()}`;
        const lockExpiresAt = addMilliseconds(currentNow, Math.max(1, input.lease_ms));
        const timeoutMs = numberValue(job.timeout_ms, 0);
        const timeoutAt = timeoutMs > 0 ? addMilliseconds(currentNow, timeoutMs) : null;
        await execSql(tx, `
          UPDATE memory_jobs
          SET status = 'active',
              attempts_started = attempts_started + 1,
              lock_token = ${placeholder(tx, 1)},
              lock_owner = ${placeholder(tx, 2)},
              lock_expires_at = ${placeholder(tx, 3)},
              timeout_at = ${placeholder(tx, 4)},
              started_at = COALESCE(started_at, ${placeholder(tx, 5)}),
              updated_at = ${placeholder(tx, 6)}
          WHERE id = ${placeholder(tx, 7)}
        `, [lockToken, input.worker_id, lockExpiresAt, timeoutAt, currentNow, currentNow, input.job_id]);
        if (job.status === 'active') {
          await insertEvent(tx, {
            id: `job-event:${crypto.randomUUID()}`,
            job_id: input.job_id,
            event_type: 'stale_lock_reclaimed',
            metadata_json: { previous_status: job.status },
            created_at: currentNow,
            worker_id: input.worker_id,
          });
        }
        await insertEvent(tx, {
          id: `job-event:${crypto.randomUUID()}`,
          job_id: input.job_id,
          event_type: 'job_claimed',
          metadata_json: { lease_ms: input.lease_ms },
          created_at: currentNow,
          worker_id: input.worker_id,
        });
        return normalizeRecord(requireJob(await selectJob(tx, input.job_id), input.job_id));
      });
    },

    async claimNextJob(input) {
      return withRuntimeTransaction(engine, async (tx) => {
        const currentNow = now();
        const pressure = options.foregroundPressure?.();
        if (pressure?.active) {
          await insertEvent(tx, {
            id: `job-event:${crypto.randomUUID()}`,
            job_id: null,
            event_type: 'claim_paused_for_foreground_pressure',
            metadata_json: { reason: pressure.reason ?? 'foreground_pressure' },
            created_at: currentNow,
            worker_id: input.worker_id,
          });
          return null;
        }
        const lockToken = `lock-token:${crypto.randomUUID()}`;
        const lockExpiresAt = addMilliseconds(currentNow, Math.max(1, input.lease_ms));
        let claimed: Record<string, unknown> | null;

        if (tx.kind === 'sqlite') {
          const candidate = await selectOne(tx, `
            SELECT *
            FROM memory_jobs
            WHERE queue = ${placeholder(tx, 1)}
              AND (
                status = 'waiting'
                OR (status = 'delayed' AND next_run_at <= ${placeholder(tx, 2)})
                OR (status = 'active' AND lock_expires_at <= ${placeholder(tx, 2)})
              )
            ORDER BY priority DESC, next_run_at ASC, created_at ASC, id ASC
            LIMIT 1
          `, [input.queue, currentNow]);
          if (!candidate) return null;
          const timeoutAt = numberValue(candidate.timeout_ms, 0) > 0
            ? addMilliseconds(currentNow, numberValue(candidate.timeout_ms, 0))
            : null;
          await execSql(tx, `
            UPDATE memory_jobs
            SET status = 'active',
                attempts_started = attempts_started + 1,
                lock_token = ${placeholder(tx, 1)},
                lock_owner = ${placeholder(tx, 2)},
                lock_expires_at = ${placeholder(tx, 3)},
                timeout_at = ${placeholder(tx, 4)},
                started_at = COALESCE(started_at, ${placeholder(tx, 5)}),
                updated_at = ${placeholder(tx, 6)}
            WHERE id = ${placeholder(tx, 7)}
          `, [lockToken, input.worker_id, lockExpiresAt, timeoutAt, currentNow, currentNow, candidate.id]);
          claimed = await selectOne(tx, `
            SELECT *, ${placeholder(tx, 2)} AS previous_status
            FROM memory_jobs
            WHERE id = ${placeholder(tx, 1)}
          `, [candidate.id, candidate.status]);
        } else {
          claimed = await selectOne(tx, `
            WITH candidate AS (
              SELECT id, status AS previous_status
              FROM memory_jobs
              WHERE queue = ${placeholder(tx, 1)}
                AND (
                  status = 'waiting'
                  OR (status = 'delayed' AND next_run_at <= ${placeholder(tx, 2)})
                  OR (status = 'active' AND lock_expires_at <= ${placeholder(tx, 2)})
                )
              ORDER BY priority DESC, next_run_at ASC, created_at ASC, id ASC
              LIMIT 1
              FOR UPDATE SKIP LOCKED
            )
            UPDATE memory_jobs AS job
            SET status = 'active',
                attempts_started = attempts_started + 1,
                lock_token = ${placeholder(tx, 3)},
                lock_owner = ${placeholder(tx, 4)},
                lock_expires_at = ${placeholder(tx, 5)},
                timeout_at = CASE
                  WHEN job.timeout_ms IS NULL THEN NULL
                  ELSE ${placeholder(tx, 2)}::timestamptz + (job.timeout_ms * interval '1 millisecond')
                END,
                started_at = COALESCE(job.started_at, ${placeholder(tx, 2)}),
                updated_at = ${placeholder(tx, 2)}
            FROM candidate
            WHERE job.id = candidate.id
            RETURNING job.*, candidate.previous_status
          `, [input.queue, currentNow, lockToken, input.worker_id, lockExpiresAt]);
        }

        if (!claimed) return null;
        if (claimed.previous_status === 'active') {
          await insertEvent(tx, {
            id: `job-event:${crypto.randomUUID()}`,
            job_id: String(claimed.id),
            event_type: 'stale_lock_reclaimed',
            metadata_json: { previous_status: claimed.previous_status },
            created_at: currentNow,
            worker_id: input.worker_id,
          });
        }
        await insertEvent(tx, {
          id: `job-event:${crypto.randomUUID()}`,
          job_id: String(claimed.id),
          event_type: 'job_claimed',
          metadata_json: { lease_ms: input.lease_ms },
          created_at: currentNow,
          worker_id: input.worker_id,
        });
        return normalizeRecord(claimed);
      });
    },

    async renewJobLease(input) {
      return withRuntimeTransaction(engine, async (tx) => {
        const currentNow = now();
        const job = requireActiveLockedJob(await selectJobForUpdate(tx, input.job_id), input.job_id, input.lock_token);
        const lockExpiresAt = addMilliseconds(currentNow, Math.max(1, input.lease_ms));
        const progressUpdated = input.progress_json !== undefined;
        if (progressUpdated) {
          await execSql(tx, `
            UPDATE memory_jobs
            SET lock_expires_at = ${placeholder(tx, 1)},
                progress_json = ${jsonExpr(tx, 2)},
                updated_at = ${placeholder(tx, 3)}
            WHERE id = ${placeholder(tx, 4)}
          `, [lockExpiresAt, input.progress_json ?? {}, currentNow, input.job_id]);
        } else {
          await execSql(tx, `
            UPDATE memory_jobs
            SET lock_expires_at = ${placeholder(tx, 1)},
                updated_at = ${placeholder(tx, 2)}
            WHERE id = ${placeholder(tx, 3)}
          `, [lockExpiresAt, currentNow, input.job_id]);
        }
        await insertEvent(tx, {
          id: `job-event:${crypto.randomUUID()}`,
          job_id: input.job_id,
          event_type: 'job_lease_renewed',
          metadata_json: {
            lease_ms: input.lease_ms,
            progress_updated: progressUpdated,
          },
          created_at: currentNow,
          worker_id: optionalString(job.lock_owner) ?? undefined,
        });
        return normalizeRecord(requireJob(await selectJob(tx, input.job_id), input.job_id));
      });
    },

    async completeJob(input) {
      return withRuntimeTransaction(engine, async (tx) => {
        const currentNow = now();
        requireActiveLockedJob(await selectJobForUpdate(tx, input.job_id), input.job_id, input.lock_token);
        await execSql(tx, `
          UPDATE memory_jobs
          SET status = 'completed',
              attempts_finished = attempts_finished + 1,
              result_json = ${jsonExpr(tx, 1)},
              lock_token = NULL,
              lock_owner = NULL,
              lock_expires_at = NULL,
              timeout_at = NULL,
              finished_at = ${placeholder(tx, 2)},
              updated_at = ${placeholder(tx, 2)}
          WHERE id = ${placeholder(tx, 3)}
        `, [input.result_json ?? {}, currentNow, input.job_id]);
        await insertEvent(tx, {
          id: `job-event:${crypto.randomUUID()}`,
          job_id: input.job_id,
          event_type: 'job_completed',
          metadata_json: {},
          created_at: currentNow,
        });
        return normalizeRecord(requireJob(await selectJob(tx, input.job_id), input.job_id));
      });
    },

    async failJob(input) {
      return withRuntimeTransaction(engine, async (tx) => {
        const currentNow = now();
        const job = requireActiveLockedJob(await selectJobForUpdate(tx, input.job_id), input.job_id, input.lock_token);
        const attemptsFinished = numberValue(job.attempts_finished, 0) + 1;
        const retry = shouldRetryFailure(job, input, attemptsFinished);
        const status = retry ? 'delayed' : (input.retryable === false ? 'failed' : 'dead');
        const nextRunAt = retry ? addMilliseconds(currentNow, computeBackoffDelay(job, attemptsFinished)) : job.next_run_at;
        const finishedAt = retry ? job.finished_at ?? null : currentNow;
        await execSql(tx, `
          UPDATE memory_jobs
          SET status = ${placeholder(tx, 1)},
              attempts_finished = ${placeholder(tx, 2)},
              failure_class = ${placeholder(tx, 3)},
              last_error = ${placeholder(tx, 4)},
              lock_token = NULL,
              lock_owner = NULL,
              lock_expires_at = NULL,
              timeout_at = NULL,
              next_run_at = ${placeholder(tx, 5)},
              finished_at = ${placeholder(tx, 6)},
              updated_at = ${placeholder(tx, 7)}
          WHERE id = ${placeholder(tx, 8)}
        `, [status, attemptsFinished, input.failure_class, input.message, nextRunAt, finishedAt, currentNow, input.job_id]);
        await insertEvent(tx, {
          id: `job-event:${crypto.randomUUID()}`,
          job_id: input.job_id,
          event_type: retry ? 'job_retry_scheduled' : (status === 'dead' ? 'job_dead' : 'job_failed'),
          metadata_json: { message: input.message },
          failure_class: input.failure_class,
          created_at: currentNow,
        });
        return normalizeRecord(requireJob(await selectJob(tx, input.job_id), input.job_id));
      });
    },

    async sweepTimedOutJobs() {
      return withRuntimeTransaction(engine, async (tx) => {
        const currentNow = now();
        const rows = await queryRows(tx, `
          SELECT *
          FROM memory_jobs
          WHERE status = 'active'
            AND timeout_at <= ${placeholder(tx, 1)}
          ORDER BY timeout_at ASC, id ASC
          ${tx.kind === 'sqlite' ? '' : 'FOR UPDATE'}
        `, [currentNow]);
        const updated: Array<Record<string, unknown>> = [];
        for (const job of rows) {
          const attemptsFinished = numberValue(job.attempts_finished, 0) + 1;
          const retry = attemptsFinished < numberValue(job.max_attempts, 1);
          const status = retry ? 'delayed' : 'dead';
          const nextRunAt = retry ? addMilliseconds(currentNow, computeBackoffDelay(job, attemptsFinished)) : job.next_run_at;
          const finishedAt = retry ? job.finished_at ?? null : currentNow;
          await execSql(tx, `
            UPDATE memory_jobs
            SET status = ${placeholder(tx, 1)},
                attempts_finished = ${placeholder(tx, 2)},
                failure_class = 'timeout',
                last_error = 'maintenance job timed out',
                lock_token = NULL,
                lock_owner = NULL,
                lock_expires_at = NULL,
                timeout_at = NULL,
                next_run_at = ${placeholder(tx, 3)},
                finished_at = ${placeholder(tx, 4)},
                updated_at = ${placeholder(tx, 5)}
            WHERE id = ${placeholder(tx, 6)}
          `, [status, attemptsFinished, nextRunAt, finishedAt, currentNow, job.id]);
          await insertEvent(tx, {
            id: `job-event:${crypto.randomUUID()}`,
            job_id: String(job.id),
            event_type: retry ? 'job_timeout_retry_scheduled' : 'job_dead',
            metadata_json: retry ? {} : { reason: 'timeout' },
            failure_class: 'timeout',
            created_at: currentNow,
          });
          updated.push(normalizeRecord(requireJob(await selectJob(tx, String(job.id)), String(job.id))));
        }
        return updated;
      });
    },

    async getJob(id) {
      const row = await selectJob(executor, id);
      return row ? normalizeRecord(row) : null;
    },

    async listJobs(filters = {}) {
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (filters.name) {
        params.push(filters.name);
        clauses.push(`name = ${placeholder(executor, params.length)}`);
      }
      if (filters.queue) {
        params.push(filters.queue);
        clauses.push(`queue = ${placeholder(executor, params.length)}`);
      }
      if (filters.status) {
        params.push(filters.status);
        clauses.push(`status = ${placeholder(executor, params.length)}`);
      }
      const limit = Math.min(500, Math.max(1, numberValue(filters.limit, 100)));
      params.push(limit);
      return (await queryRows(executor, `
        SELECT *
        FROM memory_jobs
        ${clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''}
        ORDER BY priority DESC, next_run_at ASC, created_at ASC, id ASC
        LIMIT ${placeholder(executor, params.length)}
      `, params)).map(normalizeRecord);
    },

    async listJobEvents(jobId) {
      return (await queryRows(executor, `
        SELECT *
        FROM memory_job_events
        WHERE job_id = ${placeholder(executor, 1)}
        ORDER BY created_at ASC, id ASC
      `, [jobId])).map(normalizeRecord);
    },

    async listRuntimeEvents() {
      return (await queryRows(executor, `
        SELECT *
        FROM memory_job_events
        WHERE job_id IS NULL
        ORDER BY created_at ASC, id ASC
      `)).map(normalizeRecord);
    },

    async appendJobLog(input) {
      await execSql(executor, `
        INSERT INTO memory_job_logs (id, job_id, level, message, metadata_json, created_at)
        VALUES (
          ${placeholder(executor, 1)}, ${placeholder(executor, 2)}, ${placeholder(executor, 3)},
          ${placeholder(executor, 4)}, ${jsonExpr(executor, 5)}, ${placeholder(executor, 6)}
        )
      `, [
        `job-log:${crypto.randomUUID()}`,
        input.job_id,
        input.level,
        input.message,
        input.metadata_json ?? {},
        now(),
      ]);
    },

    async acquireCycleLock(input) {
      return withRuntimeTransaction(engine, async (tx) => {
        await lockTable(tx, 'memory_cycle_locks');
        const currentNow = now();
        const existing = await selectOne(tx, `
          SELECT *
          FROM memory_cycle_locks
          WHERE cycle_name = ${placeholder(tx, 1)}
          ${tx.kind === 'sqlite' ? '' : 'FOR UPDATE'}
        `, [input.cycle_name]);
        if (existing && Date.parse(stringDateValue(existing.ttl_expires_at)) > Date.parse(currentNow)) {
          const sameHolder = numberValue(existing.holder_pid, -1) === input.holder_pid
            && existing.holder_host === input.holder_host
            && existing.holder_kind === input.holder_kind;
          if (!sameHolder) {
            return {
              status: 'busy',
              current_holder: {
                holder_pid: numberValue(existing.holder_pid, 0),
                holder_host: String(existing.holder_host),
                holder_kind: String(existing.holder_kind),
                ttl_expires_at: stringDateValue(existing.ttl_expires_at),
              },
            };
          }
        }

        const ttlExpiresAt = addMilliseconds(currentNow, Math.max(1, input.ttl_ms));
        if (existing) {
          await execSql(tx, `
            UPDATE memory_cycle_locks
            SET holder_pid = ${placeholder(tx, 1)},
                holder_host = ${placeholder(tx, 2)},
                holder_kind = ${placeholder(tx, 3)},
                ttl_expires_at = ${placeholder(tx, 4)},
                heartbeat_at = ${placeholder(tx, 5)}
            WHERE cycle_name = ${placeholder(tx, 6)}
          `, [input.holder_pid, input.holder_host, input.holder_kind, ttlExpiresAt, currentNow, input.cycle_name]);
        } else {
          await execSql(tx, `
            INSERT INTO memory_cycle_locks (
              id, cycle_name, holder_pid, holder_host, holder_kind, acquired_at, ttl_expires_at, heartbeat_at
            ) VALUES (
              ${placeholder(tx, 1)}, ${placeholder(tx, 2)}, ${placeholder(tx, 3)}, ${placeholder(tx, 4)},
              ${placeholder(tx, 5)}, ${placeholder(tx, 6)}, ${placeholder(tx, 7)}, ${placeholder(tx, 8)}
            )
          `, [
            `cycle-lock:${crypto.randomUUID()}`,
            input.cycle_name,
            input.holder_pid,
            input.holder_host,
            input.holder_kind,
            currentNow,
            ttlExpiresAt,
            currentNow,
          ]);
        }
        await insertEvent(tx, {
          id: `job-event:${crypto.randomUUID()}`,
          job_id: null,
          event_type: existing ? 'cycle_lock_refreshed_or_reclaimed' : 'cycle_lock_acquired',
          metadata_json: { cycle_name: input.cycle_name, holder_host: input.holder_host },
          created_at: currentNow,
        });
        const lock = normalizeRecord(requireJob(await selectOne(tx, `
          SELECT *
          FROM memory_cycle_locks
          WHERE cycle_name = ${placeholder(tx, 1)}
        `, [input.cycle_name]), input.cycle_name));
        return { status: 'acquired', lock: lock as unknown as MaintenanceCycleLock };
      });
    },

    async releaseCycleLock(input) {
      return withRuntimeTransaction(engine, async (tx) => {
        await lockTable(tx, 'memory_cycle_locks');
        const existing = await selectOne(tx, `
          SELECT *
          FROM memory_cycle_locks
          WHERE cycle_name = ${placeholder(tx, 1)}
          ${tx.kind === 'sqlite' ? '' : 'FOR UPDATE'}
        `, [input.cycle_name]);
        if (!existing) return { status: 'not_found' };
        const sameHolder = numberValue(existing.holder_pid, -1) === input.holder_pid
          && existing.holder_host === input.holder_host
          && existing.holder_kind === input.holder_kind;
        if (!sameHolder) return { status: 'not_holder' };
        await execSql(tx, `
          DELETE FROM memory_cycle_locks
          WHERE cycle_name = ${placeholder(tx, 1)}
        `, [input.cycle_name]);
        await insertEvent(tx, {
          id: `job-event:${crypto.randomUUID()}`,
          job_id: null,
          event_type: 'cycle_lock_released',
          metadata_json: { cycle_name: input.cycle_name },
          created_at: now(),
        });
        return { status: 'released' };
      });
    },

    async recordWorkerHeartbeat(input) {
      const currentNow = now();
      await execSql(executor, `
        INSERT INTO memory_worker_heartbeats (worker_id, worker_host, worker_pid, queues, last_seen_at, metadata_json)
        VALUES (
          ${placeholder(executor, 1)}, ${placeholder(executor, 2)}, ${placeholder(executor, 3)},
          ${jsonExpr(executor, 4)}, ${placeholder(executor, 5)}, ${jsonExpr(executor, 6)}
        )
        ON CONFLICT (worker_id) DO UPDATE SET
          worker_host = excluded.worker_host,
          worker_pid = excluded.worker_pid,
          queues = excluded.queues,
          last_seen_at = excluded.last_seen_at,
          metadata_json = excluded.metadata_json
      `, [
        input.worker_id,
        input.worker_host,
        input.worker_pid,
        input.queues,
        currentNow,
        input.metadata_json ?? {},
      ]);
      return normalizeRecord(requireJob(await selectOne(executor, `
        SELECT *
        FROM memory_worker_heartbeats
        WHERE worker_id = ${placeholder(executor, 1)}
      `, [input.worker_id]), input.worker_id));
    },

    async getStatus() {
      const currentNow = now();
      const depthRows = await queryRows(executor, `
        SELECT queue, COUNT(*) AS count
        FROM memory_jobs
        WHERE status IN ('waiting', 'delayed')
        GROUP BY queue
      `);
      const queueDepth = Object.fromEntries(depthRows.map((row) => [
        String(row.queue),
        numberValue(row.count, 0),
      ]));
      const failed = await selectOne(executor, `
        SELECT COUNT(*) AS count
        FROM memory_jobs
        WHERE status IN ('failed', 'dead')
      `);
      const stuckJobs = (await queryRows(executor, `
        SELECT *
        FROM memory_jobs
        WHERE status = 'active'
          AND lock_expires_at <= ${placeholder(executor, 1)}
        ORDER BY lock_expires_at ASC, id ASC
        LIMIT 100
      `, [currentNow])).map(normalizeRecord);
      const activeLocks = (await queryRows(executor, `
        SELECT *
        FROM memory_cycle_locks
        WHERE ttl_expires_at > ${placeholder(executor, 1)}
        ORDER BY acquired_at DESC
      `, [currentNow])).map(normalizeRecord);
      const heartbeats = (await queryRows(executor, `
        SELECT worker_id, worker_host, worker_pid, queues, last_seen_at, metadata_json
        FROM memory_worker_heartbeats
        ORDER BY last_seen_at DESC
        LIMIT 50
      `)).map(normalizeRecord);
      const lastCycle = await selectOne(executor, `
        SELECT *
        FROM memory_jobs
        WHERE name IN ('autopilot_cycle', 'autopilot-cycle')
          AND status IN ('completed', 'failed', 'dead', 'cancelled')
        ORDER BY COALESCE(finished_at, updated_at) DESC
        LIMIT 1
      `);

      return {
        queue_depth: queueDepth,
        failed_jobs: numberValue(failed?.count, 0),
        stuck_jobs: stuckJobs as never,
        worker_heartbeats: heartbeats as never,
        active_cycle_locks: activeLocks as never,
        last_cycle_result: lastCycle ? normalizeRecord(lastCycle) as never : null,
      };
    },

    async listWorkerHeartbeats() {
      return (await queryRows(executor, `
        SELECT worker_id, worker_host, worker_pid, queues, last_seen_at, metadata_json
        FROM memory_worker_heartbeats
        ORDER BY last_seen_at DESC
        LIMIT 50
      `)).map(normalizeRecord);
    },

    async getActiveCycleLock() {
      const row = await selectOne(executor, `
        SELECT *
        FROM memory_cycle_locks
        WHERE ttl_expires_at > ${placeholder(executor, 1)}
        ORDER BY acquired_at DESC
        LIMIT 1
      `, [now()]);
      return row ? normalizeRecord(row) : null;
    },

    async getLastCycleResult() {
      const row = await selectOne(executor, `
        SELECT *
        FROM memory_jobs
        WHERE name IN ('autopilot_cycle', 'autopilot-cycle')
          AND status IN ('completed', 'failed', 'dead', 'cancelled')
        ORDER BY COALESCE(finished_at, updated_at) DESC
        LIMIT 1
      `);
      return row ? normalizeRecord(row) : null;
    },
  };
}

function resolveSqlExecutor(engine: BrainEngine): SqlExecutor {
  const candidate = engine as BrainEngine & {
    sql?: { unsafe: (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]> };
    db?: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> };
    database?: {
      query: (sql: string) => {
        all: (...params: unknown[]) => Record<string, unknown>[];
        get: (...params: unknown[]) => Record<string, unknown> | null;
      };
      run: (sql: string, params?: unknown[]) => void;
    };
  };

  if (candidate.database) {
    return {
      kind: 'sqlite',
      query: async (sql, params = []) => candidate.database!.query(sql).all(...normalizeSqliteParams(params)) ?? [],
      exec: async (sql, params = []) => {
        candidate.database!.run(sql, normalizeSqliteParams(params));
      },
    };
  }

  if (candidate.sql) {
    return {
      kind: 'postgres',
      query: async (sql, params = []) => (await candidate.sql!.unsafe(sql, normalizePgParams(params))) ?? [],
      exec: async (sql, params = []) => {
        await candidate.sql!.unsafe(sql, normalizePgParams(params));
      },
    };
  }

  if (candidate.db) {
    return {
      kind: 'pglite',
      query: async (sql, params = []) => (await candidate.db!.query(sql, normalizePgParams(params))).rows ?? [],
      exec: async (sql, params = []) => {
        await candidate.db!.query(sql, normalizePgParams(params));
      },
    };
  }

  throw new Error('Maintenance runtime requires a SQL-capable engine');
}

async function withRuntimeTransaction<T>(
  engine: BrainEngine,
  fn: (executor: SqlExecutor) => Promise<T>,
): Promise<T> {
  return engine.transaction(async (txEngine) => fn(resolveSqlExecutor(txEngine)));
}

async function lockTable(executor: SqlExecutor, table: 'memory_jobs' | 'memory_cycle_locks'): Promise<void> {
  if (executor.kind === 'sqlite') return;
  await execSql(executor, `LOCK TABLE ${table} IN SHARE ROW EXCLUSIVE MODE`);
}

async function queryRows(executor: SqlExecutor, sql: string, params: unknown[] = []): Promise<Array<Record<string, unknown>>> {
  return executor.query(sql, params);
}

async function selectOne(executor: SqlExecutor, sql: string, params: unknown[] = []): Promise<Record<string, unknown> | null> {
  return (await executor.query(sql, params))[0] ?? null;
}

async function execSql(executor: SqlExecutor, sql: string, params: unknown[] = []): Promise<void> {
  await executor.exec(sql, params);
}

async function selectJob(executor: SqlExecutor, id: string): Promise<Record<string, unknown> | null> {
  return selectOne(executor, `
    SELECT *
    FROM memory_jobs
    WHERE id = ${placeholder(executor, 1)}
  `, [id]);
}

async function selectJobForUpdate(executor: SqlExecutor, id: string): Promise<Record<string, unknown> | null> {
  return selectOne(executor, `
    SELECT *
    FROM memory_jobs
    WHERE id = ${placeholder(executor, 1)}
    ${executor.kind === 'sqlite' ? '' : 'FOR UPDATE'}
  `, [id]);
}

async function insertEvent(
  executor: SqlExecutor,
  input: {
    id: string;
    job_id: string | null;
    event_type: string;
    metadata_json: Record<string, unknown>;
    created_at: string;
    worker_id?: string;
    failure_class?: MaintenanceFailureClass;
  },
): Promise<void> {
  await execSql(executor, `
    INSERT INTO memory_job_events (id, job_id, event_type, worker_id, failure_class, metadata_json, created_at)
    VALUES (
      ${placeholder(executor, 1)}, ${placeholder(executor, 2)}, ${placeholder(executor, 3)},
      ${placeholder(executor, 4)}, ${placeholder(executor, 5)}, ${jsonExpr(executor, 6)},
      ${placeholder(executor, 7)}
    )
  `, [
    input.id,
    input.job_id,
    input.event_type,
    input.worker_id ?? null,
    input.failure_class ?? null,
    input.metadata_json,
    input.created_at,
  ]);
}

function requireJob(row: Record<string, unknown> | null, id: string): Record<string, unknown> {
  if (!row) throw new Error(`Maintenance row not found: ${id}`);
  return row;
}

function requireActiveLockedJob(
  row: Record<string, unknown> | null,
  jobId: string,
  lockToken: string,
): Record<string, unknown> {
  const job = requireJob(row, jobId);
  if (job.status !== 'active') {
    throw new Error(`Maintenance job is not active: ${jobId}`);
  }
  if (!job.lock_token || job.lock_token !== lockToken) {
    throw new Error(`Maintenance job lock token mismatch: ${jobId}`);
  }
  return job;
}

function jobCanBeClaimed(job: Record<string, unknown>, currentNow: string): boolean {
  const status = String(job.status ?? '');
  if (status === 'waiting') return true;
  if (status === 'delayed') return Date.parse(String(job.next_run_at ?? '')) <= Date.parse(currentNow);
  if (status === 'active') return Date.parse(String(job.lock_expires_at ?? '')) <= Date.parse(currentNow);
  return false;
}

function computeBackoffDelay(job: Record<string, unknown>, attemptsFinished: number): number {
  const backoffType = stringValue(job.backoff_type, 'none');
  const delay = Math.max(0, numberValue(job.backoff_delay_ms, 0));
  if (backoffType === 'none') return 0;
  if (backoffType === 'fixed') return delay;
  return delay * Math.max(1, 2 ** Math.max(0, attemptsFinished - 1));
}

const NON_RETRYABLE_FAILURE_CLASSES = new Set<MaintenanceFailureClass>([
  'policy_denied',
  'prompt_injection_quarantine',
  'secret_redaction_required',
  'cancelled',
]);

function shouldRetryFailure(
  job: Record<string, unknown>,
  input: FailMaintenanceJobInput,
  attemptsFinished: number,
): boolean {
  if (NON_RETRYABLE_FAILURE_CLASSES.has(input.failure_class)) return false;
  return input.retryable !== false && attemptsFinished < numberValue(job.max_attempts, 1);
}

function placeholder(executor: SqlExecutor, index: number): string {
  return executor.kind === 'sqlite' ? `?${index}` : `$${index}`;
}

function jsonExpr(executor: SqlExecutor, index: number): string {
  return executor.kind === 'sqlite' ? `?${index}` : `$${index}::jsonb`;
}

function normalizePgParams(params: unknown[]): unknown[] {
  return params.map((param) => isJsonParam(param) ? JSON.stringify(param) : param);
}

function normalizeSqliteParams(params: unknown[]): unknown[] {
  return params.map((param) => isJsonParam(param) ? JSON.stringify(param) : param);
}

function isJsonParam(param: unknown): boolean {
  return Array.isArray(param) || (typeof param === 'object' && param !== null && !(param instanceof Date));
}

function normalizeRecord(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, normalizeValue(value)]));
}

function normalizeValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        return JSON.parse(trimmed);
      } catch {
        return value;
      }
    }
  }
  return value;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function stringDateValue(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return typeof value === 'string' ? value : String(value);
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function numberValue(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function optionalNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}
