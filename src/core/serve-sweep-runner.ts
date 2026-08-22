/**
 * Serve-delegated maintenance-sweep job runner (#677) — the serve process's
 * execution half of the sweep_start / sweep_status IPC kinds (wire shapes +
 * validation in context/sweep-ipc.ts; socket plumbing in
 * context/resolve-ipc.ts; CLI half in commands/sweep-delegate.ts).
 *
 * Mirror of serve-sync-runner.ts, minus the abort machinery: a sweep is a
 * BOUNDED run (default 5s budget, runMaintenanceSweep never throws), so the
 * client just polls to completion. One job at a time, in-memory,
 * module-singleton; the last TERMINAL job is retained (keyed by clientToken)
 * so a client that lost the start ack attaches instead of duplicate-running.
 *
 * After a successful sweep the runner kicks maybeDrainDeferredEmbeds — the
 * lock owner closes its own embedding loop (a no-op unless a prior delegated
 * sync deferred embeds), so a hand-run `gbrain sweep --once` against a live
 * serve converges the same backlog `embed --stale` would if it could connect.
 */

import { randomUUID } from 'node:crypto';
import type { BrainEngine } from './engine.ts';
import { runMaintenanceSweep, type SweepReport } from './sweep.ts';
import { maybeDrainDeferredEmbeds } from './serve-sync-runner.ts';
import {
  validateDelegatedSweepOptions,
  type DelegatedSweepState,
  type SweepStartResponse,
  type SweepStatusResponse,
} from './context/sweep-ipc.ts';

interface DelegatedSweepJob {
  id: string;
  clientToken: string;
  state: DelegatedSweepState;
  sourceId?: string;
  startedAt: number;
  finishedAt?: number;
  report?: SweepReport;
  jobError?: string;
  settled: Promise<void>;
}

/** Running job, or the retained last terminal job (replaced by the next start). */
let current: DelegatedSweepJob | null = null;

const isTerminal = (s: DelegatedSweepState): boolean => s === 'done' || s === 'error';

function log(msg: string): void {
  process.stderr.write(`[serve-sweep] ${msg}\n`);
}

/**
 * Handle a sweep_start request. `rawOptions` is the untrusted wire payload —
 * validated here (the runner is the single authority) even though the IPC
 * layer types it.
 */
export function startDelegatedSweep(
  engine: BrainEngine,
  rawOptions: unknown,
  clientToken: string,
  opts: { boundSourceId?: string } = {},
): SweepStartResponse {
  if (typeof clientToken !== 'string' || clientToken.length === 0 || clientToken.length > 128) {
    return { ok: false, protocol: 2, error: 'invalid_options:clientToken' };
  }
  // Token attach: a retry after a lost ack finds its own job.
  if (current && current.clientToken === clientToken) {
    return isTerminal(current.state)
      ? { ok: true, protocol: 2, jobId: current.id, completed: true }
      : { ok: true, protocol: 2, jobId: current.id };
  }
  if (current && !isTerminal(current.state)) {
    return { ok: false, protocol: 2, error: 'busy', jobId: current.id };
  }
  const v = validateDelegatedSweepOptions(rawOptions);
  if (!v.ok) return { ok: false, protocol: 2, error: v.error };
  const options = v.options;
  if (options.sourceId && opts.boundSourceId && options.sourceId !== opts.boundSourceId) {
    return { ok: false, protocol: 2, error: 'source_mismatch' };
  }

  const job: DelegatedSweepJob = {
    id: randomUUID(),
    clientToken,
    state: 'running',
    sourceId: options.sourceId ?? opts.boundSourceId ?? 'default',
    startedAt: Date.now(),
    settled: Promise.resolve(),
  };
  current = job;

  job.settled = (async () => {
    try {
      log(`start job=${job.id} source=${job.sourceId} budgetMs=${options.budgetMs ?? 5000} batchLimit=${options.batchLimit ?? 20}`);
      const report = await runMaintenanceSweep(engine, {
        sourceId: job.sourceId,
        ...(options.budgetMs !== undefined ? { budgetMs: options.budgetMs } : {}),
        ...(options.batchLimit !== undefined ? { batchLimit: options.batchLimit } : {}),
        log: (msg: string) => log(`job=${job.id} ${msg}`),
      });
      job.report = report;
      job.state = 'done';
      log(
        `done job=${job.id} facts=${report.factsReconciled} links=${report.linksExtracted} ` +
        `timeline=${report.timelineExtracted} corpus=${report.corpusIngested} in=${report.durationMs}ms`,
      );
      // Lock-owner embed loop: no-op unless a prior delegated sync deferred
      // embeds. Fire-and-forget — the sweep result never waits on embeds.
      void maybeDrainDeferredEmbeds(engine);
    } catch (e) {
      // runMaintenanceSweep never throws by contract; this catch covers the
      // structural impossible-path so a poll can still settle to 'error'.
      job.jobError = e instanceof Error ? e.message : String(e);
      job.state = 'error';
      log(`error job=${job.id}: ${job.jobError}`);
    } finally {
      job.finishedAt = Date.now();
    }
  })();

  return { ok: true, protocol: 2, jobId: job.id };
}

/** Handle a sweep_status poll. */
export function getDelegatedSweepStatus(jobId: string): SweepStatusResponse {
  const job = current;
  if (!job || job.id !== jobId) {
    return { ok: false, protocol: 2, error: 'unknown_job' };
  }
  return {
    ok: true,
    protocol: 2,
    state: job.state,
    sourceId: job.sourceId,
    startedAt: job.startedAt,
    elapsedMs: (job.finishedAt ?? Date.now()) - job.startedAt,
    ...(job.state === 'done' && job.report ? { report: job.report } : {}),
    ...(job.state === 'error' && job.jobError ? { jobError: job.jobError } : {}),
  };
}

/** Test seam: reset the module singleton (serial tests only). */
export function __resetDelegatedSweepForTests(): void {
  current = null;
}
