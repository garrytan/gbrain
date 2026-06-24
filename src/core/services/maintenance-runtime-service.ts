import {
  addMilliseconds,
  cloneJson,
  compareIso,
  defaultMaintenanceId,
  isIsoAtOrBefore,
  isTerminalMaintenanceJobStatus,
  type AcquireMaintenanceCycleLockInput,
  type ClaimMaintenanceJobByIdInput,
  type ClaimMaintenanceJobInput,
  type CompleteMaintenanceJobInput,
  type EnqueueMaintenanceJobInput,
  type FailMaintenanceJobInput,
  type ForegroundPressureState,
  type MaintenanceCycleLock,
  type MaintenanceFailureClass,
  type MaintenanceJob,
  type MaintenanceJobEvent,
  type MaintenanceJobFilters,
  type MaintenanceJobStatus,
  type MaintenanceWorkerHeartbeat,
  type RenewMaintenanceJobLeaseInput,
  type ReleaseMaintenanceCycleLockInput,
} from '../maintenance/job-runtime.ts';

export interface MaintenanceRuntimeServiceOptions {
  now?: () => string;
  nextId?: (prefix: string) => string;
  max_waiting_by_name?: Record<string, number>;
  foregroundPressure?: () => ForegroundPressureState;
  canonicalWritePolicy?: (request: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

export interface EnqueueMaintenanceJobResult {
  status: 'enqueued' | 'deduped' | 'coalesced';
  job: MaintenanceJob;
}

export interface AcquireMaintenanceCycleLockResult {
  status: 'acquired' | 'busy';
  lock?: MaintenanceCycleLock;
  current_holder?: Pick<MaintenanceCycleLock, 'holder_pid' | 'holder_host' | 'holder_kind' | 'ttl_expires_at'>;
}

export interface MaintenanceRuntimeStatus {
  queue_depth: Record<string, number>;
  failed_jobs: number;
  stuck_jobs: MaintenanceJob[];
  worker_heartbeats: MaintenanceWorkerHeartbeat[];
  active_cycle_locks: MaintenanceCycleLock[];
  last_cycle_result: MaintenanceJob | null;
}

export interface MaintenanceRuntimeService {
  enqueueJob(input: EnqueueMaintenanceJobInput): Promise<EnqueueMaintenanceJobResult>;
  claimJob(input: ClaimMaintenanceJobByIdInput): Promise<MaintenanceJob | null>;
  claimNextJob(input: ClaimMaintenanceJobInput): Promise<MaintenanceJob | null>;
  renewJobLease(input: RenewMaintenanceJobLeaseInput): Promise<MaintenanceJob>;
  completeJob(input: CompleteMaintenanceJobInput): Promise<MaintenanceJob>;
  failJob(input: FailMaintenanceJobInput): Promise<MaintenanceJob>;
  sweepTimedOutJobs(): Promise<MaintenanceJob[]>;
  getJob(id: string): Promise<MaintenanceJob | null>;
  listJobs(filters?: MaintenanceJobFilters): Promise<MaintenanceJob[]>;
  listJobEvents(jobId: string): Promise<MaintenanceJobEvent[]>;
  listRuntimeEvents(): Promise<MaintenanceJobEvent[]>;
  appendJobLog(input: { job_id: string; level: 'debug' | 'info' | 'warn' | 'error'; message: string; metadata_json?: Record<string, unknown> }): Promise<void>;
  acquireCycleLock(input: AcquireMaintenanceCycleLockInput): Promise<AcquireMaintenanceCycleLockResult>;
  releaseCycleLock(input: ReleaseMaintenanceCycleLockInput): Promise<{ status: 'released' | 'not_found' | 'not_holder' }>;
  recordWorkerHeartbeat(input: Omit<MaintenanceWorkerHeartbeat, 'last_seen_at'>): Promise<MaintenanceWorkerHeartbeat>;
  getStatus(): Promise<MaintenanceRuntimeStatus>;
  writeCanonicalMemoryFromJob(input: { job_id: string; lock_token: string; mutation: Record<string, unknown> }): Promise<never>;
  requestCanonicalWriteFromJob(input: { job_id: string; lock_token: string; policy_request: Record<string, unknown> }): Promise<Record<string, unknown>>;
}

export function createMaintenanceRuntimeService(
  options: MaintenanceRuntimeServiceOptions = {},
): MaintenanceRuntimeService {
  const state = createInMemoryState();
  const clock = options.now ?? (() => new Date().toISOString());
  const nextId = options.nextId ?? defaultMaintenanceId;

  const appendEvent = (
    jobId: string | null,
    eventType: string,
    metadata: Record<string, unknown> = {},
    workerId: string | null = null,
    failureClass: MaintenanceFailureClass | null = null,
  ): MaintenanceJobEvent => {
    const event: MaintenanceJobEvent = {
      id: nextId('job-event'),
      job_id: jobId,
      event_type: eventType,
      worker_id: workerId,
      failure_class: failureClass,
      metadata_json: cloneJson(metadata),
      created_at: clock(),
    };
    state.events.push(event);
    return event;
  };

  const isClaimableJob = (job: MaintenanceJob, now: string): boolean => (
    job.status === 'waiting'
    || (job.status === 'delayed' && isIsoAtOrBefore(job.next_run_at, now))
    || (job.status === 'active' && isIsoAtOrBefore(job.lock_expires_at, now))
  );

  const claimJobWithLock = (
    job: MaintenanceJob,
    workerId: string,
    leaseMs: number,
    now: string,
  ): MaintenanceJob => {
    if (job.status === 'active') {
      appendEvent(job.id, 'stale_lock_reclaimed', {
        previous_lock_owner: job.lock_owner,
        previous_lock_token: job.lock_token,
      }, workerId);
    }

    job.status = 'active';
    job.attempts_started += 1;
    job.lock_token = nextId('lock-token');
    job.lock_owner = workerId;
    job.lock_expires_at = addMilliseconds(now, Math.max(1, leaseMs));
    job.timeout_at = job.timeout_ms === null ? null : addMilliseconds(now, job.timeout_ms);
    job.started_at = job.started_at ?? now;
    job.updated_at = now;
    appendEvent(job.id, 'job_claimed', { lease_ms: leaseMs }, workerId);
    return cloneJob(job);
  };

  const service: MaintenanceRuntimeService = {
    async enqueueJob(input) {
      const now = clock();
      const idempotencyKey = input.idempotency_key ?? null;
      if (idempotencyKey) {
        const existing = state.jobs.find((job) => (
          job.idempotency_key === idempotencyKey
          && !isTerminalMaintenanceJobStatus(job.status)
        ));
        if (existing) {
          appendEvent(existing.id, 'submission_deduped', { idempotency_key: idempotencyKey });
          return { status: 'deduped', job: cloneJob(existing) };
        }
      }

      const maxWaiting = options.max_waiting_by_name?.[input.name];
      if (maxWaiting !== undefined) {
        const waiting = state.jobs
          .filter((job) => job.name === input.name && (job.status === 'waiting' || job.status === 'delayed'))
          .sort(jobOrder);
        if (waiting.length >= maxWaiting && waiting[0]) {
          const coalesced = waiting[0];
          coalesced.payload_json = cloneJson(input.payload_json ?? {});
          coalesced.idempotency_key = idempotencyKey;
          coalesced.updated_at = now;
          appendEvent(coalesced.id, 'submission_coalesced', {
            coalesced_idempotency_key: idempotencyKey,
          });
          return { status: 'coalesced', job: cloneJob(coalesced) };
        }
      }

      const job: MaintenanceJob = {
        id: nextId('job'),
        name: input.name,
        queue: input.queue ?? 'maintenance',
        status: 'waiting',
        priority: input.priority ?? 0,
        payload_json: cloneJson(input.payload_json ?? {}),
        result_json: null,
        progress_json: cloneJson(input.progress_json ?? {}),
        max_attempts: Math.max(1, input.max_attempts ?? 1),
        attempts_started: 0,
        attempts_finished: 0,
        backoff_type: input.backoff_type ?? 'none',
        backoff_delay_ms: Math.max(0, input.backoff_delay_ms ?? 0),
        lock_token: null,
        lock_owner: null,
        lock_expires_at: null,
        timeout_ms: input.timeout_ms ?? null,
        timeout_at: null,
        idempotency_key: idempotencyKey,
        parent_job_id: input.parent_job_id ?? null,
        failure_class: null,
        last_error: null,
        next_run_at: now,
        created_at: now,
        started_at: null,
        finished_at: null,
        updated_at: now,
      };
      state.jobs.push(job);
      appendEvent(job.id, 'job_enqueued', { idempotency_key: idempotencyKey });
      return { status: 'enqueued', job: cloneJob(job) };
    },

    async claimJob(input) {
      const pressure = options.foregroundPressure?.();
      if (pressure?.active) {
        appendEvent(null, 'claim_paused_for_foreground_pressure', { reason: pressure.reason ?? 'foreground_pressure' }, input.worker_id);
        return null;
      }

      const now = clock();
      const job = state.jobs.find((entry) => entry.id === input.job_id);
      if (
        !job
        || job.queue !== input.queue
        || (input.name !== undefined && job.name !== input.name)
        || !isClaimableJob(job, now)
      ) return null;
      return claimJobWithLock(job, input.worker_id, input.lease_ms, now);
    },

    async claimNextJob(input) {
      const pressure = options.foregroundPressure?.();
      if (pressure?.active) {
        appendEvent(null, 'claim_paused_for_foreground_pressure', { reason: pressure.reason ?? 'foreground_pressure' }, input.worker_id);
        return null;
      }

      const now = clock();
      const candidates = state.jobs
        .filter((job) => job.queue === input.queue)
        .filter((job) => isClaimableJob(job, now))
        .sort(jobOrder);
      const job = candidates[0];
      if (!job) return null;

      return claimJobWithLock(job, input.worker_id, input.lease_ms, now);
    },

    async renewJobLease(input) {
      const job = requireActiveLockedJob(state.jobs, input.job_id, input.lock_token);
      const now = clock();
      const progressUpdated = input.progress_json !== undefined;
      job.lock_expires_at = addMilliseconds(now, Math.max(1, input.lease_ms));
      if (progressUpdated) {
        job.progress_json = cloneJson(input.progress_json ?? {});
      }
      job.updated_at = now;
      appendEvent(job.id, 'job_lease_renewed', {
        lease_ms: input.lease_ms,
        progress_updated: progressUpdated,
      }, job.lock_owner);
      return cloneJob(job);
    },

    async completeJob(input) {
      const job = requireActiveLockedJob(state.jobs, input.job_id, input.lock_token);
      const now = clock();
      job.status = 'completed';
      job.attempts_finished += 1;
      job.result_json = cloneJson(input.result_json ?? {});
      job.lock_token = null;
      job.lock_owner = null;
      job.lock_expires_at = null;
      job.timeout_at = null;
      job.finished_at = now;
      job.updated_at = now;
      appendEvent(job.id, 'job_completed');
      return cloneJob(job);
    },

    async failJob(input) {
      const job = requireActiveLockedJob(state.jobs, input.job_id, input.lock_token);
      const now = clock();
      const attemptsFinished = job.attempts_finished + 1;
      job.attempts_finished = attemptsFinished;
      const retry = shouldRetryFailure(job, input);
      job.status = retry ? 'delayed' : (input.retryable === false ? 'failed' : 'dead');
      job.failure_class = input.failure_class;
      job.last_error = input.message;
      job.lock_token = null;
      job.lock_owner = null;
      job.lock_expires_at = null;
      job.timeout_at = null;
      job.next_run_at = retry ? addMilliseconds(now, computeBackoffDelay(job)) : job.next_run_at;
      job.finished_at = retry ? job.finished_at : now;
      job.updated_at = now;
      appendEvent(
        job.id,
        retry ? 'job_retry_scheduled' : (job.status === 'dead' ? 'job_dead' : 'job_failed'),
        { message: input.message },
        null,
        input.failure_class,
      );
      return cloneJob(job);
    },

    async sweepTimedOutJobs() {
      const now = clock();
      const expiredActive = state.jobs.filter((job) => (
        job.status === 'active'
        && (
          (job.timeout_at !== null && isIsoAtOrBefore(job.timeout_at, now))
          || isIsoAtOrBefore(job.lock_expires_at, now)
        )
      ));
      const updated: MaintenanceJob[] = [];
      for (const job of expiredActive) {
        const staleLock = !isIsoAtOrBefore(job.timeout_at, now) && isIsoAtOrBefore(job.lock_expires_at, now);
        const failureClass = staleLock ? 'lock_timeout' : 'timeout';
        const attemptsFinished = job.attempts_finished + 1;
        const retry = attemptsFinished < job.max_attempts;
        job.attempts_finished = attemptsFinished;
        job.status = retry ? 'delayed' : 'dead';
        job.failure_class = failureClass;
        job.last_error = staleLock ? 'maintenance job lock expired' : 'maintenance job timed out';
        job.lock_token = null;
        job.lock_owner = null;
        job.lock_expires_at = null;
        job.timeout_at = null;
        job.next_run_at = retry ? addMilliseconds(now, computeBackoffDelay(job)) : job.next_run_at;
        job.finished_at = retry ? job.finished_at : now;
        job.updated_at = now;
        appendEvent(
          job.id,
          retry ? (staleLock ? 'job_stale_lock_retry_scheduled' : 'job_timeout_retry_scheduled') : 'job_dead',
          retry ? {} : { reason: staleLock ? 'stale_lock' : 'timeout' },
          null,
          failureClass,
        );
        updated.push(cloneJob(job));
      }
      return updated;
    },

    async getJob(id) {
      const job = state.jobs.find((entry) => entry.id === id);
      return job ? cloneJob(job) : null;
    },

    async listJobs(filters = {}) {
      const limit = filters.limit ?? 100;
      return state.jobs
        .filter((job) => !filters.name || job.name === filters.name)
        .filter((job) => !filters.queue || job.queue === filters.queue)
        .filter((job) => !filters.status || job.status === filters.status)
        .sort(jobOrder)
        .slice(0, limit)
        .map(cloneJob);
    },

    async listJobEvents(jobId) {
      return state.events
        .filter((event) => event.job_id === jobId)
        .map(cloneEvent);
    },

    async listRuntimeEvents() {
      return state.events
        .filter((event) => event.job_id === null)
        .map(cloneEvent);
    },

    async appendJobLog(input) {
      state.logs.push({
        id: nextId('job-log'),
        job_id: input.job_id,
        level: input.level,
        message: input.message,
        metadata_json: cloneJson(input.metadata_json ?? {}),
        created_at: clock(),
      });
    },

    async acquireCycleLock(input) {
      const now = clock();
      const existing = state.cycleLocks.get(input.cycle_name);
      if (existing && Date.parse(existing.ttl_expires_at) > Date.parse(now)) {
        const sameHolder = existing.holder_pid === input.holder_pid
          && existing.holder_host === input.holder_host
          && existing.holder_kind === input.holder_kind;
        if (!sameHolder) {
          return {
            status: 'busy',
            current_holder: {
              holder_pid: existing.holder_pid,
              holder_host: existing.holder_host,
              holder_kind: existing.holder_kind,
              ttl_expires_at: existing.ttl_expires_at,
            },
          };
        }
      }

      const lock: MaintenanceCycleLock = {
        id: existing?.id ?? nextId('cycle-lock'),
        cycle_name: input.cycle_name,
        holder_pid: input.holder_pid,
        holder_host: input.holder_host,
        holder_kind: input.holder_kind,
        acquired_at: existing?.acquired_at ?? now,
        ttl_expires_at: addMilliseconds(now, Math.max(1, input.ttl_ms)),
        heartbeat_at: now,
      };
      state.cycleLocks.set(input.cycle_name, lock);
      appendEvent(null, existing ? 'cycle_lock_refreshed_or_reclaimed' : 'cycle_lock_acquired', {
        cycle_name: input.cycle_name,
        holder_host: input.holder_host,
      });
      return { status: 'acquired', lock: cloneJson(lock) };
    },

    async releaseCycleLock(input) {
      const existing = state.cycleLocks.get(input.cycle_name);
      if (!existing) return { status: 'not_found' };
      const sameHolder = existing.holder_pid === input.holder_pid
        && existing.holder_host === input.holder_host
        && existing.holder_kind === input.holder_kind;
      if (!sameHolder) return { status: 'not_holder' };
      state.cycleLocks.delete(input.cycle_name);
      appendEvent(null, 'cycle_lock_released', { cycle_name: input.cycle_name });
      return { status: 'released' };
    },

    async recordWorkerHeartbeat(input) {
      const heartbeat: MaintenanceWorkerHeartbeat = {
        ...cloneJson(input),
        last_seen_at: clock(),
      };
      state.workerHeartbeats.set(input.worker_id, heartbeat);
      return cloneJson(heartbeat);
    },

    async getStatus() {
      const now = clock();
      const queueDepth: Record<string, number> = {};
      for (const job of state.jobs) {
        if (job.status === 'waiting' || job.status === 'delayed') {
          queueDepth[job.queue] = (queueDepth[job.queue] ?? 0) + 1;
        }
      }
      const activeLocks = [...state.cycleLocks.values()]
        .filter((lock) => Date.parse(lock.ttl_expires_at) > Date.parse(now))
        .map((lock) => cloneJson(lock));
      const lastCycle = [...state.jobs]
        .filter((job) => (job.name === 'autopilot_cycle' || job.name === 'autopilot-cycle')
          && isTerminalMaintenanceJobStatus(job.status))
        .sort((a, b) => compareIso(b.finished_at ?? b.updated_at, a.finished_at ?? a.updated_at))[0] ?? null;

      return {
        queue_depth: queueDepth,
        failed_jobs: state.jobs.filter((job) => job.status === 'failed' || job.status === 'dead').length,
        stuck_jobs: state.jobs
          .filter((job) => job.status === 'active' && isIsoAtOrBefore(job.lock_expires_at, now))
          .map(cloneJob),
        worker_heartbeats: [...state.workerHeartbeats.values()].map((entry) => cloneJson(entry)),
        active_cycle_locks: activeLocks,
        last_cycle_result: lastCycle ? cloneJob(lastCycle) : null,
      };
    },

    async writeCanonicalMemoryFromJob(input) {
      requireActiveLockedJob(state.jobs, input.job_id, input.lock_token);
      throw new Error('Maintenance jobs must use the Phase 04 canonical write policy callback before mutating canonical memory.');
    },

    async requestCanonicalWriteFromJob(input) {
      requireActiveLockedJob(state.jobs, input.job_id, input.lock_token);
      if (!options.canonicalWritePolicy) {
        throw new Error('Phase 04 canonical write policy callback is not configured.');
      }
      const request = {
        job_id: input.job_id,
        ...cloneJson(input.policy_request),
      };
      return cloneJson(await options.canonicalWritePolicy(request));
    },
  };

  return service;
}

function createInMemoryState() {
  return {
    jobs: [] as MaintenanceJob[],
    events: [] as MaintenanceJobEvent[],
    logs: [] as Array<{
      id: string;
      job_id: string;
      level: 'debug' | 'info' | 'warn' | 'error';
      message: string;
      metadata_json: Record<string, unknown>;
      created_at: string;
    }>,
    cycleLocks: new Map<string, MaintenanceCycleLock>(),
    workerHeartbeats: new Map<string, MaintenanceWorkerHeartbeat>(),
  };
}

function jobOrder(a: MaintenanceJob, b: MaintenanceJob): number {
  if (a.priority !== b.priority) return b.priority - a.priority;
  return compareIso(a.next_run_at ?? a.created_at, b.next_run_at ?? b.created_at)
    || compareIso(a.created_at, b.created_at)
    || a.id.localeCompare(b.id);
}

function computeBackoffDelay(job: MaintenanceJob): number {
  if (job.backoff_type === 'none') return 0;
  if (job.backoff_type === 'fixed') return job.backoff_delay_ms;
  return job.backoff_delay_ms * Math.max(1, 2 ** Math.max(0, job.attempts_finished - 1));
}

const NON_RETRYABLE_FAILURE_CLASSES = new Set<MaintenanceFailureClass>([
  'policy_denied',
  'prompt_injection_quarantine',
  'secret_redaction_required',
  'cancelled',
]);

function shouldRetryFailure(job: MaintenanceJob, input: FailMaintenanceJobInput): boolean {
  if (NON_RETRYABLE_FAILURE_CLASSES.has(input.failure_class)) return false;
  return input.retryable !== false && job.attempts_finished < job.max_attempts;
}

function requireActiveLockedJob(
  jobs: MaintenanceJob[],
  jobId: string,
  lockToken: string,
): MaintenanceJob {
  const job = jobs.find((entry) => entry.id === jobId);
  if (!job) {
    throw new Error(`Maintenance job not found: ${jobId}`);
  }
  if (job.status !== 'active') {
    throw new Error(`Maintenance job is not active: ${jobId}`);
  }
  if (!job.lock_token || job.lock_token !== lockToken) {
    throw new Error(`Maintenance job lock token mismatch: ${jobId}`);
  }
  return job;
}

function cloneJob(job: MaintenanceJob): MaintenanceJob {
  return cloneJson(job);
}

function cloneEvent(event: MaintenanceJobEvent): MaintenanceJobEvent {
  return cloneJson(event);
}

export type {
  MaintenanceCycleLock,
  MaintenanceFailureClass,
  MaintenanceJob,
  MaintenanceJobEvent,
  MaintenanceJobFilters,
  MaintenanceJobStatus,
  MaintenanceWorkerHeartbeat,
};
