/**
 * `gbrain jobs run-child` core (issue #5 — per-job process isolation).
 *
 * The child side of the isolation boundary. The PARENT worker owns claim,
 * lock renewal, completeJob/failJob and all attempt accounting; this process
 * only executes the handler and reports ONE outcome file (see
 * job-isolation.ts for the protocol). Child-owns-engine: every ctx callback
 * below is token-fenced, so if the job is reclaimed while we run, our writes
 * degrade to no-ops.
 *
 * Deliberately runs NONE of the worker machinery: no health probe, no stall
 * detection, no lock timer — the parent is the sole liveness owner. What it
 * does install:
 *
 *   - SIGTERM handler → fires shutdownSignal ONLY (inline signal-separation
 *     parity): cooperative handlers keep ctx.signal live, finish inside the
 *     drain window, and write their outcome before the parent escalates to a
 *     group SIGKILL. Handlers that watch shutdownSignal (shell) run their own
 *     SIGTERM→grace→SIGKILL cleanup.
 *   - Parent-liveness watchdog: polls `process.kill(parentPid, 0)` every 15s
 *     (a ppid check is DEAD CODE under tini — the child's ppid is tini,
 *     which outlives the worker). On parent death: abort both signals, and
 *     hard-exit after a 30s grace so an orphaned LLM-bound handler doesn't
 *     burn spend to completion. Lock expiry + the stall sweeper requeue the
 *     job on the parent's side of the world.
 *
 * The CLI layer (jobs.ts case 'run-child') owns engine.disconnect() and
 * process.exit() — this module returns an exit code (engine-ownership
 * invariant, same as MinionWorker).
 */

import type { BrainEngine } from '../engine.ts';
import { MinionQueue } from './queue.ts';
import type { MinionHandler } from './types.ts';
import { buildJobContext } from './job-context.ts';
import { withChatPhase } from '../ai/chat-usage.ts';
import {
  JOB_CHILD_EXIT_NOT_CLAIMED,
  JOB_CHILD_EXIT_RESULT_WRITE_FAILED,
} from './worker-exit-codes.ts';
import { encodeHandlerError, unrefTimer, writeChildOutcomeFile } from './job-isolation.ts';

export interface RunChildOpts {
  jobId: number;
  lockToken: string;
  resultPath: string;
  /** Worker pid for the liveness watchdog; 0/absent disables the watchdog. */
  parentPid: number;
}

export interface RunChildInjectables {
  /** Hermetic tests inject a handler map instead of registerBuiltinHandlers. */
  resolveHandler: (name: string) => MinionHandler | undefined;
  /** Watchdog cadence override (default 15s). */
  parentPollMs?: number;
  /** Orphan hard-exit grace override (default 30s). */
  orphanGraceMs?: number;
  /** Exit hook for tests (default process.exit for the orphan path only). */
  hardExit?: (code: number) => void;
}

export async function runChildJobEntry(
  engine: BrainEngine,
  opts: RunChildOpts,
  injectables: RunChildInjectables,
): Promise<number> {
  const queue = new MinionQueue(engine);

  // Ground truth is the DB row, re-read here (one SELECT) rather than a
  // serialized payload: the parent claimed it, but reclaim/cancel can race
  // our startup. A mismatch means we must not run the handler at all.
  const job = await queue.getJob(opts.jobId);
  if (!job || job.status !== 'active' || job.lock_token !== opts.lockToken) {
    process.stderr.write(
      `[run-child] job ${opts.jobId} is not claimed by this token ` +
      `(status=${job?.status ?? 'missing'}) — exiting without running the handler\n`,
    );
    return JOB_CHILD_EXIT_NOT_CLAIMED;
  }

  const handler = injectables.resolveHandler(job.name);
  if (!handler) {
    // Parity with inline mode, which dead-letters a missing handler
    // immediately (failJob 'dead') — 'unrecoverable' reconstructs to
    // UnrecoverableError parent-side, so the parent dead-letters on attempt 1
    // instead of retrying a deterministic condition (adversarial-review P3).
    try {
      writeChildOutcomeFile(opts.resultPath, {
        outcome: 'error',
        errorKind: 'unrecoverable',
        message: `No handler for job type '${job.name}' in the isolation child`,
      });
      return 0;
    } catch {
      return JOB_CHILD_EXIT_RESULT_WRITE_FAILED;
    }
  }

  const abort = new AbortController();
  const shutdown = new AbortController();

  // SIGTERM = worker shutdown: fire ONLY shutdownSignal, preserving the
  // inline signal-separation contract (worker.ts aborts only shutdownAbort on
  // SIGTERM; per-job ctx.signal stays live so cooperative handlers finish +
  // report inside the drain window instead of aborting mid-deploy —
  // adversarial-review P2). The parent's group SIGKILL at drain end is the
  // backstop for handlers that keep running.
  const onSigterm = (): void => {
    if (!shutdown.signal.aborted) shutdown.abort(new Error('worker-shutdown'));
  };
  // Parent death (orphan) aborts BOTH: nobody will SIGKILL us, the lock will
  // expire and the job will be requeued — stop the handler outright.
  const onOrphaned = (): void => {
    onSigterm();
    if (!abort.signal.aborted) abort.abort(new Error('worker-shutdown'));
  };
  process.on('SIGTERM', onSigterm);

  // Parent-liveness watchdog (unref'd — never keeps the child alive).
  const pollMs = injectables.parentPollMs ?? 15_000;
  const graceMs = injectables.orphanGraceMs ?? 30_000;
  const hardExit = injectables.hardExit ?? ((code: number) => process.exit(code));
  let watchdog: ReturnType<typeof setInterval> | null = null;
  if (opts.parentPid > 0) {
    watchdog = setInterval(() => {
      try {
        process.kill(opts.parentPid, 0);
      } catch {
        process.stderr.write(
          `[run-child] parent worker (pid ${opts.parentPid}) is gone — aborting handler; ` +
          `hard exit in ${Math.round(graceMs / 1000)}s\n`,
        );
        if (watchdog != null) clearInterval(watchdog);
        onOrphaned();
        const t = setTimeout(() => hardExit(1), graceMs);
        unrefTimer(t);
      }
    }, pollMs);
    unrefTimer(watchdog);
  }

  try {
    const context = buildJobContext(
      engine,
      queue,
      job,
      opts.lockToken,
      abort.signal,
      shutdown.signal,
    );
    let outcome;
    try {
      // #4218: same phase attribution as the in-process worker path — the
      // isolated child runs its own gateway, so the wrap must live here too.
      const result = await withChatPhase(`job:${job.name}`, () => handler(context));
      // completeJob's {value: x} wrap decision must run BEFORE JSON
      // serialization: a JSON round-trip changes typeof for Date /
      // toJSON-bearing results (object → string), which would flip the wrap
      // parent-side (adversarial-review P3, result-shape parity). Wrap here;
      // the parent's own wrap is then a no-op (object/undefined passthrough).
      const wrapped = result != null
        ? (typeof result === 'object' ? (result as Record<string, unknown>) : { value: result })
        : undefined;
      outcome = { outcome: 'success' as const, result: wrapped };
    } catch (err) {
      outcome = encodeHandlerError(err);
    }
    try {
      writeChildOutcomeFile(opts.resultPath, outcome);
    } catch (writeErr) {
      const msg = writeErr instanceof Error ? writeErr.message : String(writeErr);
      process.stderr.write(`[run-child] failed to write outcome file: ${msg}\n`);
      return JOB_CHILD_EXIT_RESULT_WRITE_FAILED;
    }
    return 0;
  } finally {
    if (watchdog != null) clearInterval(watchdog);
    process.off('SIGTERM', onSigterm);
  }
}
