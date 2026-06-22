import type {
  ClaimMaintenanceJobByIdInput,
  CompleteMaintenanceJobInput,
  EnqueueMaintenanceJobInput,
  FailMaintenanceJobInput,
  RenewMaintenanceJobLeaseInput,
} from '../maintenance/job-runtime.ts';
import type { BrainEngine } from '../engine.ts';
import { getEmbeddingProvider } from '../embedding.ts';
import type { ResolvedEmbeddingProvider } from '../embedding/provider.ts';
import {
  runEmbeddingBackfill,
  type EmbeddingBackfillSummary,
} from './embedding-backfill-service.ts';

export type EmbedBackfillMode = 'stale' | 'all';

export interface SubmitEmbedBackfillJobInput {
  mode?: EmbedBackfillMode;
  timeout_ms?: number;
  idempotency_scope?: string;
}

export interface RunEmbedBackfillJobInput {
  engine: BrainEngine;
  runtime: EmbedBackfillJobRuntime;
  job_id: string;
  worker_id?: string;
  lease_ms?: number;
  provider?: ResolvedEmbeddingProvider;
}

export interface RunEmbedBackfillJobResult {
  status: 'completed';
  job: EmbedBackfillRuntimeJob;
  result: EmbeddingBackfillSummary;
}

export interface EmbedBackfillRuntimeJob {
  id: string;
  name?: string;
  lock_token?: string | null;
  payload_json?: Record<string, unknown>;
  progress_json?: Record<string, unknown>;
}

export interface EmbedBackfillJobRuntime {
  enqueueJob(input: EnqueueMaintenanceJobInput): Promise<{ status: 'enqueued' | 'deduped' | 'coalesced' | string; job: EmbedBackfillRuntimeJob }>;
  claimJob(input: ClaimMaintenanceJobByIdInput): Promise<EmbedBackfillRuntimeJob | null>;
  renewJobLease(input: RenewMaintenanceJobLeaseInput): Promise<EmbedBackfillRuntimeJob>;
  completeJob(input: CompleteMaintenanceJobInput): Promise<EmbedBackfillRuntimeJob>;
  failJob(input: FailMaintenanceJobInput): Promise<EmbedBackfillRuntimeJob>;
}

const EMBED_BACKFILL_QUEUE = 'maintenance';
const EMBED_BACKFILL_JOB_NAME = 'embed_backfill';
const DEFAULT_WORKER_ID = 'embed-backfill:inline';
const DEFAULT_LEASE_MS = 60_000;

export async function submitEmbedBackfillJob(
  runtime: EmbedBackfillJobRuntime,
  input: SubmitEmbedBackfillJobInput = {},
): Promise<{ status: 'enqueued' | 'deduped' | 'coalesced' | string; job: EmbedBackfillRuntimeJob }> {
  const mode = normalizeMode(input.mode);
  const scope = normalizeIdempotencyScope(input.idempotency_scope);
  return runtime.enqueueJob({
    name: EMBED_BACKFILL_JOB_NAME,
    queue: EMBED_BACKFILL_QUEUE,
    payload_json: { mode },
    progress_json: initialEmbedBackfillProgress(),
    idempotency_key: `embed-backfill:${mode}:${scope}`,
    // The backfill is idempotent (only re-embeds unembedded chunks), so a transient
    // provider/write blip should retry with backoff instead of dead-lettering the run.
    max_attempts: 3,
    backoff_type: 'exponential',
    backoff_delay_ms: 5000,
    timeout_ms: input.timeout_ms,
  });
}

export async function runEmbedBackfillJob(input: RunEmbedBackfillJobInput): Promise<RunEmbedBackfillJobResult> {
  const runtime = input.runtime;
  const leaseMs = Math.max(1, input.lease_ms ?? DEFAULT_LEASE_MS);
  const workerId = input.worker_id ?? DEFAULT_WORKER_ID;
  const claimed = await claimEmbedBackfillJob(runtime, {
    job_id: input.job_id,
    queue: EMBED_BACKFILL_QUEUE,
    name: EMBED_BACKFILL_JOB_NAME,
    worker_id: workerId,
    lease_ms: leaseMs,
  });
  const lockToken = typeof claimed?.lock_token === 'string' ? claimed.lock_token : null;
  if (!claimed || claimed.id !== input.job_id || claimed.name !== EMBED_BACKFILL_JOB_NAME || !lockToken) {
    throw new Error(`embed_backfill job is not claimable: ${input.job_id}`);
  }

  const provider = input.provider ?? getEmbeddingProvider();
  if (!provider.capability.available) {
    const message = provider.capability.reason || 'Embedding provider unavailable';
    await runtime.failJob({
      job_id: input.job_id,
      lock_token: lockToken,
      failure_class: 'runner_unavailable',
      message,
      retryable: false,
    });
    throw new Error(message);
  }

  const payload = recordField(claimed.payload_json);
  const mode = normalizeMode(payload.mode);
  let latestProgress = recordField(claimed.progress_json);
  const heartbeat = startLeaseHeartbeat(
    async () => {
      await runtime.renewJobLease({
        job_id: input.job_id,
        lock_token: lockToken,
        lease_ms: leaseMs,
        progress_json: latestProgress,
      });
    },
    Math.max(1, Math.floor(leaseMs / 2)),
  );

  let summary: EmbeddingBackfillSummary;
  try {
    summary = await runEmbeddingBackfill(input.engine, {
      staleOnly: mode === 'stale',
      provider,
      onProgress: async snapshot => {
        latestProgress = toJsonRecord(snapshot);
        await runtime.renewJobLease({
          job_id: input.job_id,
          lock_token: lockToken,
          lease_ms: leaseMs,
          progress_json: latestProgress,
        });
      },
    });
  } catch (error) {
    heartbeat.stop();
    await runtime.failJob({
      job_id: input.job_id,
      lock_token: lockToken,
      failure_class: 'internal',
      message: error instanceof Error ? error.message : String(error),
      retryable: false,
    });
    throw error;
  }
  const heartbeatError = heartbeat.stop();
  if (heartbeatError) {
    await runtime.failJob({
      job_id: input.job_id,
      lock_token: lockToken,
      failure_class: 'internal',
      message: formatUnknownError(heartbeatError),
      retryable: false,
    });
    throw heartbeatError;
  }
  if (summary.provider_failures > 0 || summary.write_failures > 0) {
    const message = formatBackfillFailureMessage(summary);
    await runtime.failJob({
      job_id: input.job_id,
      lock_token: lockToken,
      failure_class: 'internal',
      // Partial failures are typically transient provider/write blips; retry with backoff.
      // Idempotent backfill only re-embeds the chunks that still lack an embedding.
      retryable: true,
      message,
    });
    throw new Error(message);
  }

  const completed = await runtime.completeJob({
    job_id: input.job_id,
    lock_token: lockToken,
    result_json: toJsonRecord(summary),
  });
  return { status: 'completed', job: completed, result: summary };
}

function initialEmbedBackfillProgress(): Record<string, unknown> {
  return {
    page_offset: 0,
    pages_scanned: 0,
    pages_touched: 0,
    chunks_queued: 0,
    chunks_embedded: 0,
    skipped_derived_refresh_pages: 0,
    provider_failures: 0,
    write_failures: 0,
    window_count: 0,
  };
}

async function claimEmbedBackfillJob(
  runtime: EmbedBackfillJobRuntime,
  input: ClaimMaintenanceJobByIdInput,
): Promise<EmbedBackfillRuntimeJob | null> {
  return runtime.claimJob(input);
}

function startLeaseHeartbeat(
  renew: () => Promise<void>,
  intervalMs: number,
): { stop: () => unknown } {
  let stopped = false;
  let error: unknown = null;
  const timer = setInterval(() => {
    if (stopped || error) return;
    void renew().catch((caught) => {
      if (!stopped) error = caught;
    });
  }, intervalMs);

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
      return error;
    },
  };
}

function formatBackfillFailureMessage(summary: EmbeddingBackfillSummary): string {
  return `embed_backfill completed with failures: provider_failures=${summary.provider_failures}, write_failures=${summary.write_failures}`;
}

function normalizeMode(value: unknown): EmbedBackfillMode {
  return value === 'all' ? 'all' : 'stale';
}

function normalizeIdempotencyScope(value: unknown): string {
  return typeof value === 'string' && value.length > 0 ? value : 'default';
}

function recordField(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function toJsonRecord(input: object): Record<string, unknown> {
  return { ...(input as Record<string, unknown>) };
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
