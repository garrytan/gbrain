import type { BrainEngine } from './engine.ts';
import { normalizeDerivedJobLeaseDurationMs, normalizeDerivedJobMaxAttempts } from './derived-jobs.ts';
import { refreshDerivedStorageForPage, type ImportResult } from './import-file.ts';
import type { DerivedJob } from './types.ts';

export interface DerivedWorkerOptions {
  leaseOwner?: string;
  leaseDurationMs?: number;
  maxAttempts?: number;
  maxJobs?: number;
  pollIntervalMs?: number;
  shouldYieldToForeground?: () => boolean;
  abortSignal?: AbortSignal;
  refreshPage?: (job: DerivedJob, context: DerivedWorkerRefreshContext) => Promise<ImportResult>;
  onError?: (error: unknown) => void;
}

export interface DerivedWorkerRefreshContext {
  signal?: AbortSignal;
}

export interface DerivedWorkerDrainResult {
  claimed: number;
  completed: number;
  failed: number;
  deferred: number;
  idle: boolean;
}

export interface DerivedWorkerController {
  stop(): void;
}

const DEFAULT_DERIVED_WORKER_POLL_INTERVAL_MS = 1_000;
const DEFAULT_DERIVED_WORKER_MAX_JOBS = 1;

export async function drainDerivedJobsOnce(
  engine: BrainEngine,
  options: DerivedWorkerOptions = {},
): Promise<DerivedWorkerDrainResult> {
  const leaseOwner = options.leaseOwner ?? `mbrain-derived-worker-${process.pid}`;
  const leaseDurationMs = normalizeDerivedJobLeaseDurationMs(options.leaseDurationMs);
  const maxAttempts = normalizeDerivedJobMaxAttempts(options.maxAttempts);
  const maxJobs = normalizeMaxJobs(options.maxJobs);
  const refreshPage = options.refreshPage ?? ((job: DerivedJob) => refreshDerivedStorageForPage(engine, job.slug, {
    path: job.manifest_path ?? undefined,
    expectedContentHash: job.target_content_hash,
    leaseOwner,
    leaseArtifactKind: job.artifact_kind,
    signal: options.abortSignal,
  }));
  const result: DerivedWorkerDrainResult = {
    claimed: 0,
    completed: 0,
    failed: 0,
    deferred: 0,
    idle: false,
  };
  const shouldDefer = () => options.abortSignal?.aborted === true || options.shouldYieldToForeground?.() === true;

  for (let index = 0; index < maxJobs; index += 1) {
    if (shouldDefer()) {
      result.deferred += 1;
      break;
    }

    const job = await engine.claimNextDerivedJob({
      lease_owner: leaseOwner,
      lease_duration_ms: leaseDurationMs,
    });
    if (!job) {
      result.idle = result.claimed === 0;
      break;
    }
    result.claimed += 1;

    if (shouldDefer()) {
      await engine.releaseDerivedJobLease({
        id: job.id,
        lease_owner: leaseOwner,
      });
      result.deferred += 1;
      break;
    }

    try {
      const refreshed = await refreshPage(job, { signal: options.abortSignal });
      if (refreshed.status === 'skipped') {
        if (shouldDefer()) {
          await engine.releaseDerivedJobLease({
            id: job.id,
            lease_owner: leaseOwner,
          });
          result.deferred += 1;
          break;
        }
        throw new Error(refreshed.error ?? 'Derived refresh skipped.');
      }
      result.completed += 1;
    } catch (error) {
      if (shouldDefer()) {
        await engine.releaseDerivedJobLease({
          id: job.id,
          lease_owner: leaseOwner,
        });
        result.deferred += 1;
        break;
      }
      await engine.markDerivedJobFailed({
        id: job.id,
        error: error instanceof Error ? error.message : String(error),
        lease_owner: leaseOwner,
        max_attempts: maxAttempts,
      });
      result.failed += 1;
    }
  }

  return result;
}

export function startDerivedWorker(
  engine: BrainEngine,
  options: DerivedWorkerOptions = {},
): DerivedWorkerController {
  const pollIntervalMs = normalizePollIntervalMs(options.pollIntervalMs);
  const abortController = new AbortController();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const drainOptions: DerivedWorkerOptions = {
    ...options,
    abortSignal: abortController.signal,
    shouldYieldToForeground: () => (
      abortController.signal.aborted
      || options.abortSignal?.aborted === true
      || options.shouldYieldToForeground?.() === true
    ),
  };

  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(run, pollIntervalMs);
  };

  const run = async () => {
    if (stopped) return;
    try {
      await drainDerivedJobsOnce(engine, drainOptions);
    } catch (error) {
      options.onError?.(error);
    } finally {
      schedule();
    }
  };

  schedule();
  return {
    stop() {
      stopped = true;
      abortController.abort();
      if (timer) clearTimeout(timer);
    },
  };
}

function normalizeMaxJobs(value: number | undefined): number {
  if (!Number.isFinite(value) || value === undefined || value <= 0) {
    return DEFAULT_DERIVED_WORKER_MAX_JOBS;
  }
  return Math.max(1, Math.floor(value));
}

function normalizePollIntervalMs(value: number | undefined): number {
  if (!Number.isFinite(value) || value === undefined || value <= 0) {
    return DEFAULT_DERIVED_WORKER_POLL_INTERVAL_MS;
  }
  return Math.max(1, Math.floor(value));
}
