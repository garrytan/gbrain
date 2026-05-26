export const MAINTENANCE_JOB_STATUSES = [
  'waiting',
  'active',
  'completed',
  'failed',
  'dead',
  'cancelled',
  'delayed',
  'paused',
  'waiting_children',
] as const;

export type MaintenanceJobStatus = typeof MAINTENANCE_JOB_STATUSES[number];

export const MAINTENANCE_FAILURE_CLASSES = [
  'database',
  'lock_timeout',
  'runner_unavailable',
  'llm_unavailable',
  'policy_denied',
  'source_unavailable',
  'prompt_injection_quarantine',
  'secret_redaction_required',
  'projection_failed',
  'timeout',
  'cancelled',
  'internal',
] as const;

export type MaintenanceFailureClass = typeof MAINTENANCE_FAILURE_CLASSES[number];

export type MaintenanceBackoffType = 'none' | 'fixed' | 'exponential';

export interface MaintenanceJob {
  id: string;
  name: string;
  queue: string;
  status: MaintenanceJobStatus;
  priority: number;
  payload_json: Record<string, unknown>;
  result_json: Record<string, unknown> | null;
  progress_json: Record<string, unknown>;
  max_attempts: number;
  attempts_started: number;
  attempts_finished: number;
  backoff_type: MaintenanceBackoffType;
  backoff_delay_ms: number;
  lock_token: string | null;
  lock_owner: string | null;
  lock_expires_at: string | null;
  timeout_ms: number | null;
  timeout_at: string | null;
  idempotency_key: string | null;
  parent_job_id: string | null;
  failure_class: MaintenanceFailureClass | null;
  last_error: string | null;
  next_run_at: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
}

export interface MaintenanceJobEvent {
  id: string;
  job_id: string | null;
  event_type: string;
  worker_id: string | null;
  failure_class: MaintenanceFailureClass | null;
  metadata_json: Record<string, unknown>;
  created_at: string;
}

export interface MaintenanceJobLog {
  id: string;
  job_id: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  metadata_json: Record<string, unknown>;
  created_at: string;
}

export interface MaintenanceJobArtifact {
  id: string;
  job_id: string;
  artifact_kind: string;
  artifact_ref: string;
  metadata_json: Record<string, unknown>;
  created_at: string;
}

export interface MaintenanceCycleLock {
  id: string;
  cycle_name: string;
  holder_pid: number;
  holder_host: string;
  holder_kind: string;
  acquired_at: string;
  ttl_expires_at: string;
  heartbeat_at: string;
}

export interface MaintenanceWorkerHeartbeat {
  worker_id: string;
  worker_host: string;
  worker_pid: number;
  queues: string[];
  last_seen_at: string;
  metadata_json: Record<string, unknown>;
}

export interface ForegroundPressureState {
  active: boolean;
  reason?: string;
}

export interface EnqueueMaintenanceJobInput {
  name: string;
  queue?: string;
  priority?: number;
  payload_json?: Record<string, unknown>;
  progress_json?: Record<string, unknown>;
  max_attempts?: number;
  backoff_type?: MaintenanceBackoffType;
  backoff_delay_ms?: number;
  timeout_ms?: number | null;
  idempotency_key?: string | null;
  parent_job_id?: string | null;
}

export interface ClaimMaintenanceJobInput {
  queue: string;
  worker_id: string;
  lease_ms: number;
}

export interface FailMaintenanceJobInput {
  job_id: string;
  lock_token: string;
  failure_class: MaintenanceFailureClass;
  message: string;
  retryable?: boolean;
}

export interface CompleteMaintenanceJobInput {
  job_id: string;
  lock_token: string;
  result_json?: Record<string, unknown>;
}

export interface AcquireMaintenanceCycleLockInput {
  cycle_name: string;
  holder_pid: number;
  holder_host: string;
  holder_kind: string;
  ttl_ms: number;
}

export interface ReleaseMaintenanceCycleLockInput {
  cycle_name: string;
  holder_pid: number;
  holder_host: string;
  holder_kind: string;
}

export interface MaintenanceJobFilters {
  name?: string;
  queue?: string;
  status?: MaintenanceJobStatus;
  limit?: number;
}

export function isTerminalMaintenanceJobStatus(status: MaintenanceJobStatus): boolean {
  return status === 'completed'
    || status === 'failed'
    || status === 'dead'
    || status === 'cancelled';
}

export function addMilliseconds(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString();
}

export function compareIso(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return Date.parse(a) - Date.parse(b);
}

export function isIsoAtOrBefore(value: string | null, now: string): boolean {
  return value !== null && Date.parse(value) <= Date.parse(now);
}

export function defaultMaintenanceId(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`;
}

export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
