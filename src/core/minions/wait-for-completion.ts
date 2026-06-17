/**
 * Poll-until-terminal helper for CLI callers. Minions doesn't ship a
 * notification stream for arbitrary callers (the NOTIFY trigger is worker-
 * side), so `gbrain agent run --follow` on the CLI side polls getJob() until
 * the job reaches a terminal state.
 *
 * On timeout, the job is NOT cancelled — the user can `gbrain jobs get <id>`
 * later to check. Explicit cancellation is the user's call via `gbrain jobs
 * cancel <id>`.
 */

import type { MinionQueue } from './queue.ts';
import type { MinionJob, MinionJobStatus } from './types.ts';

export class TimeoutError extends Error {
  constructor(public readonly jobId: number, public readonly elapsedMs: number) {
    super(`timeout after ${elapsedMs}ms waiting for job ${jobId}`);
    this.name = 'TimeoutError';
  }
}

const TERMINAL_STATES: readonly MinionJobStatus[] = ['completed', 'failed', 'dead', 'cancelled'] as const;
const TERMINAL_SET = new Set<MinionJobStatus>(TERMINAL_STATES);

export interface WaitOpts {
  /** Abort after this many ms. Default: 24h (long enough for most durable runs). */
  timeoutMs?: number;
  /**
   * Poll interval. Defaults:
   *   - 1000ms on Postgres (lighter load, concurrent followers scale)
   *   - 250ms when the caller knows it's on PGLite inline (single process,
   *     no network RTT)
   * Callers pass the appropriate value explicitly — this module doesn't
   * introspect the engine.
   */
  pollMs?: number;
  /** Optional AbortSignal — on abort, the poll loop exits early (no TimeoutError). */
  signal?: AbortSignal;
}

export async function waitForCompletion(
  queue: MinionQueue,
  jobId: number,
  opts: WaitOpts = {},
): Promise<MinionJob> {
  const timeoutMs = opts.timeoutMs ?? 24 * 60 * 60 * 1000;
  const pollMs = opts.pollMs ?? 1000;
  const started = Date.now();

  // Fast-path first read (don't wait pollMs just to learn it's already done).
  let job = await queue.getJob(jobId);
  if (!job) throw new Error(`job ${jobId} not found`);
  if (TERMINAL_SET.has(job.status)) return job;

  while (true) {
    if (opts.signal?.aborted) {
      // Caller aborted. Return the last-seen snapshot rather than throwing —
      // the job itself is still alive queue-side, and the caller knows they
      // aborted.
      return job;
    }
    const elapsed = Date.now() - started;
    if (elapsed >= timeoutMs) {
      throw new TimeoutError(jobId, elapsed);
    }
    const remaining = timeoutMs - elapsed;
    const sleep = Math.min(pollMs, remaining);
    await delay(sleep, opts.signal);

    job = await queue.getJob(jobId);
    if (!job) throw new Error(`job ${jobId} disappeared mid-wait`);
    if (TERMINAL_SET.has(job.status)) return job;
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// Exported for unit tests.
export const __testing = {
  TERMINAL_STATES,
};
