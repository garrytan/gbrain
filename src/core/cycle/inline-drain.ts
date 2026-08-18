/**
 * Inline drain for the dream cycle's private per-run child queues (peeled from
 * synthesize.ts; #4194 adds bounded concurrency).
 *
 * Why inline on BOTH engines:
 *   - PGLite: no separate Minions worker can run at all (the embedded
 *     data-dir holds an exclusive file lock), so children would sit in
 *     'waiting' until waitForCompletion times out.
 *   - Postgres (#2050): the parent phase itself runs as a job inside a
 *     `jobs work` process. A worker whose slots are all occupied by such
 *     parents can never claim the child the parent is blocking on — a
 *     structural self-deadlock. Running children inline means a child never
 *     needs a worker slot.
 *
 * Concurrency model (#4194): N independent `drainLoop`s share the queue via
 * the same SKIP-LOCKED `queue.claim` fencing workers use at concurrency N.
 * Everything job-scoped (lockToken, abort, timeout timer, keepalive,
 * renewTimer, outcome recording) is loop-local. Pool hygiene:
 *   - Housekeeping sweeps (handleStalled/handleTimeouts/handleWallClock) are
 *     LEADER-ONLY (loop 0) — they're global, idempotent SQL and N copies per
 *     iteration would add pooler load on exactly the deployments #4194 is
 *     about. `promoteDelayed` runs in EVERY loop: it is the cheap sweep that
 *     picks up 0-delay retries, and any surviving loop must be able to do it
 *     (the leader may have exited on an empty queue while a sibling's child
 *     was still running and later failed to 'delayed').
 *   - A NON-RETRYABLE loop-level failure aborts sibling loops after their
 *     current child (shared poolAbort). A child failure is NOT a loop failure
 *     — one failing child never blocks siblings (#4194 acceptance).
 *   - Provider ceilings stay with the rate leases: the handler's lease
 *     acquisition (legacy per-turn, gateway per-turn hook, oneshot per-call)
 *     is the API limiter; a lease-full child requeues WITHOUT burning an
 *     attempt (worker parity), so inline concurrency above the lease cap
 *     degrades to waiting, never to dead-letters.
 */

import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { MinionQueue } from '../minions/queue.ts';
import type { MinionHandler, MinionJobContext } from '../minions/types.ts';
import { UnrecoverableError } from '../minions/types.ts';
import { makeSubagentHandler } from '../minions/handlers/subagent.ts';
import { RateLeaseUnavailableError, leaseFullBackoffMs } from '../minions/rate-leases.ts';
import { reconnectAfterConnectionError } from '../minions/reconnect.ts';
import { isRetryableConnError } from '../retry-matcher.ts';
import { CYCLE_DEADLINE_RESERVE_MS } from './base-phase.ts';

/**
 * #4168: minimum budget a freshly-claimed child is worth starting with.
 * Mirrors patterns.ts's MIN_PATTERNS_SUBAGENT_BUDGET_MS (importing it here
 * would close a module cycle: patterns → synthesize → inline-drain).
 */
const MIN_CHILD_BUDGET_MS = 2 * 60 * 1000;

export const INLINE_LOCK_MS = 30_000;

/**
 * One lock-renewal tick with a per-call timeout + cancellation. The renewal
 * query rides an AbortSignal that is aborted when the timeout wins the race
 * (the query is cancelled and its slot released), and callers guard
 * re-entrancy so at most one renewal is in flight.
 *
 * Returns after the renewal settles or times out; a `false` renewal invokes
 * `onLost` (token fence lost — caller aborts the handler). Errors and
 * timeouts are swallowed: best-effort, the next tick retries.
 */
export async function runDrainRenewalTick(
  renewLock: (
    id: number,
    lockToken: string,
    lockMs: number,
    opts?: { signal?: AbortSignal },
  ) => Promise<boolean>,
  jobId: number,
  lockToken: string,
  lockMs: number,
  onLost: () => void,
  callTimeoutMs: number,
): Promise<void> {
  const callAbort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const ok = await Promise.race([
      renewLock(jobId, lockToken, lockMs, { signal: callAbort.signal }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          callAbort.abort();
          reject(new Error(`renewLock timed out after ${callTimeoutMs}ms`));
        }, callTimeoutMs);
      }),
    ]);
    if (!ok) onLost();
  } catch {
    /* best-effort; next tick retries */
  } finally {
    if (timer != null) clearTimeout(timer);
  }
}

/**
 * Nearest-rank percentile over an unsorted sample. Returns null on an empty
 * sample (never NaN — the phase-details JSON must stay clean when a run had
 * zero or one child).
 */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export async function runSubagentsInline(
  engine: BrainEngine,
  queue: MinionQueue,
  queueName: string,
  yieldDuringPhase?: () => Promise<void>,
  handler: MinionHandler = makeSubagentHandler({ engine }),
  lockMs: number = INLINE_LOCK_MS,
  concurrency = 1,
  /** #4168 adversarial: absolute parent-job deadline. When the remaining
   *  budget drops under the minimum child budget, loops stop CLAIMING —
   *  the caller cancels the still-waiting children and defers their
   *  transcripts (children submit fast, so submit-time clamps alone cannot
   *  bound a sequential multi-child drain). Residual, documented: each
   *  loop's LAST claimed child may still overrun the parent by up to its
   *  own clamped timeout. */
  deadlineAtMs: number | null = null,
): Promise<void> {
  const n = Math.max(1, Math.floor(concurrency));
  if (n === 1) {
    // Serial fast path: identical semantics to the pre-#4194 drain.
    await drainLoop(engine, queue, queueName, yieldDuringPhase, handler, lockMs, 0, null, deadlineAtMs);
    return;
  }
  const poolAbort = new AbortController();
  const settled = await Promise.allSettled(
    Array.from({ length: n }, (_, loopIdx) =>
      drainLoop(engine, queue, queueName, yieldDuringPhase, handler, lockMs, loopIdx, poolAbort, deadlineAtMs)),
  );
  // allSettled (not all): a rejecting loop must not strand siblings'
  // in-flight children mid-record. The first non-retryable rejection is
  // rethrown after every loop has wound down.
  const firstRejection = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected');
  if (firstRejection) throw firstRejection.reason;
}

async function drainLoop(
  engine: BrainEngine,
  queue: MinionQueue,
  queueName: string,
  yieldDuringPhase: (() => Promise<void>) | undefined,
  handler: MinionHandler,
  lockMs: number,
  loopIdx: number,
  poolAbort: AbortController | null,
  deadlineAtMs: number | null = null,
): Promise<void> {
  // #3555 interaction: the drain's queue ops used to be bare awaits, so a
  // transient pooler reap mid-drain threw out of the loop and stranded the
  // remaining children in this per-run private queue — which no worker will
  // ever claim. Mirror the worker's recovery: on a retryable connection
  // error, rebuild the pool (shared reconnectAfterConnectionError) and retry
  // the loop; non-retryable errors still propagate (real bug → phase fails).
  // Conn-error streak is PER-LOOP (one loop's reconnect window is its own).
  const MAX_CONN_ERROR_STREAK = 5;
  let connErrorStreak = 0;
  let idlePollMs = 1000;
  const recoverOrThrow = async (site: string, e: unknown): Promise<void> => {
    if (!isRetryableConnError(e) || ++connErrorStreak > MAX_CONN_ERROR_STREAK) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`[dream] inline drain ${site} hit a connection error; reconnecting and retrying: ${msg}\n`);
    await reconnectAfterConnectionError(engine, `inline-${site}`, e);
    // Small cooperative backoff (setTimeout keeps the cycle-lock keepalive
    // and any concurrent timers firing) before the loop retries.
    await new Promise((r) => setTimeout(r, Math.min(1000, Math.max(50, Math.floor(lockMs / 3)))));
  };

  try {
    while (true) {
      // Shared-abort check: a sibling loop hit a non-retryable failure. Stop
      // claiming new children; the sibling's rejection carries the cause.
      if (poolAbort?.signal.aborted) return;
      // #4168 adversarial: stop claiming when the parent budget cannot fit
      // another child. Already-running work is unaffected; unclaimed
      // children stay 'waiting' for the caller's cancel-and-defer pass.
      if (
        deadlineAtMs != null &&
        deadlineAtMs - CYCLE_DEADLINE_RESERVE_MS - Date.now() < MIN_CHILD_BUDGET_MS
      ) {
        return;
      }
      const lockToken = randomUUID();
      let job: Awaited<ReturnType<MinionQueue['claim']>>;
      try {
        // Housekeeping a worker would normally perform, so child rows can
        // reach terminal states before the synth parent enters
        // waitForCompletion polling. Global sweeps are leader-only (pool
        // hygiene, see module docblock); promoteDelayed runs everywhere so
        // any surviving loop picks up 0-delay retries.
        await queue.promoteDelayed();
        if (loopIdx === 0) {
          await queue.handleStalled();
          await queue.handleTimeouts();
          await queue.handleWallClockTimeouts(lockMs);
        }
        job = await queue.claim(lockToken, lockMs, queueName, ['subagent']);
      } catch (e) {
        await recoverOrThrow('queue-ops', e);
        continue;
      }
      connErrorStreak = 0;
      if (!job) {
        // Exit ONLY when the queue is truly quiet. Three non-claimable-but-
        // live shapes must keep the loop polling instead of returning:
        //   - 'active' under a sibling loop or under a lock nobody renews
        //     after a connection-error window (handleStalled requeues it once
        //     the lock expires, ≤ lockMs);
        //   - 'delayed' with a future delay_until — the lease-full bounce
        //     requeues with a 1-3s backoff (worker parity, #4194), and
        //     exiting here would strand the child until the parent's
        //     waitForCompletion timed out;
        //   - 'waiting' that lost a claim race this iteration.
        let pending = 0;
        try {
          const rows = await engine.executeRaw<{ n: number }>(
            `SELECT count(*)::int AS n FROM minion_jobs
              WHERE queue = $1 AND status IN ('active', 'waiting', 'delayed')`,
            [queueName],
          );
          pending = rows[0]?.n ?? 0;
        } catch (e) {
          await recoverOrThrow('pending-check', e);
          continue;
        }
        if (pending === 0) return;
        // Idle poll with backoff (1s → 5s): under a pool, idle loops must not
        // hammer the queue while the last slow child drains.
        await new Promise((r) => setTimeout(r, idlePollMs));
        idlePollMs = Math.min(5000, idlePollMs * 2);
        continue;
      }
      idlePollMs = 1000;

      const abort = new AbortController();
      const shutdown = new AbortController();
      const context: MinionJobContext = {
        id: job.id,
        name: job.name,
        data: job.data,
        attempts_made: job.attempts_made,
        signal: abort.signal,
        deadlineAtMs: job.timeout_at != null ? job.timeout_at.getTime() : null,
        shutdownSignal: shutdown.signal,
        updateProgress: async (progress: unknown) => {
          await queue.updateProgress(job.id, lockToken, progress);
        },
        updateTokens: async (tokens) => {
          await queue.updateTokens(job.id, lockToken, tokens);
        },
        log: async (message) => {
          const value = typeof message === 'string' ? message : JSON.stringify(message);
          await engine.executeRaw(
            `UPDATE minion_jobs SET stacktrace = COALESCE(stacktrace, '[]'::jsonb) || to_jsonb($1::text),
              updated_at = now()
             WHERE id = $2 AND status = 'active' AND lock_token = $3`,
            [value, job.id, lockToken],
          );
        },
        isActive: async () => {
          const rows = await engine.executeRaw<{ id: number }>(
            `SELECT id FROM minion_jobs WHERE id = $1 AND status = 'active' AND lock_token = $2`,
            [job.id, lockToken],
          );
          return rows.length > 0;
        },
        readInbox: async () => queue.readInbox(job.id, lockToken),
      };

      // Per-job deadline enforcement (worker.ts parity). While the drain loop
      // awaits the handler, the handleTimeouts sweep above can't run, so
      // nothing else can stop a child that blows past timeout_ms — the
      // handler only stops when ctx.signal fires. Derive the delay from the
      // claim-time timeout_at stamp so timer, DB sweeper, and deadlineAtMs
      // agree.
      let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
      if (job.timeout_ms != null) {
        const delayMs = job.timeout_at != null
          ? Math.max(0, job.timeout_at.getTime() - Date.now())
          : job.timeout_ms;
        timeoutTimer = setTimeout(() => {
          if (!abort.signal.aborted) abort.abort(new Error('timeout'));
        }, delayMs);
      }

      // Cycle-lock keepalive while the child runs (best-effort, never throws).
      // Concurrent invocation from N loops is safe: the callback is a
      // timestamp-refresh UPDATE on the cycle-lock row (verified against
      // buildYieldDuringPhase; ENG-2).
      const keepalive = yieldDuringPhase
        ? setInterval(() => { yieldDuringPhase().catch(() => { /* best-effort */ }); }, 60_000)
        : null;
      // #2050: heartbeat the child's claim lock while the handler runs so a
      // concurrent Postgres worker's handleStalled() sweep (all queues, not
      // just its own) can't requeue a live child. A false return means the
      // row was cancelled or reclaimed — abort the handler. Errors are
      // swallowed (best-effort; the next tick retries), never an
      // unhandledRejection. Re-entrancy guard + per-call cancellation via
      // runDrainRenewalTick: a hung renewLock no longer stacks a fresh
      // checked-out pool slot per interval firing (issue #6 abandoned-racer
      // class).
      let drainTickInFlight = false;
      const renewTimer = setInterval(() => {
        if (drainTickInFlight) return;
        drainTickInFlight = true;
        void runDrainRenewalTick(
          (id, tok, ms, opts) => queue.renewLock(id, tok, ms, opts),
          job.id,
          lockToken,
          lockMs,
          () => {
            if (!abort.signal.aborted) abort.abort(new Error('lock-renewal-failed'));
          },
          Math.max(1000, Math.floor(lockMs / 3)),
        ).finally(() => {
          drainTickInFlight = false;
        });
      }, Math.max(50, Math.floor(lockMs / 3)));
      // Run, then record — separated so a completeJob connection error can't
      // masquerade as a handler failure, and a failJob connection error can't
      // escape the drain and strand the remaining children (worker.ts #1720
      // parity: reconnect + retry the recording once; if it still fails,
      // leave the row for the loop's own handleStalled to requeue after lock
      // expiry).
      let result: unknown;
      let handlerErr: unknown;
      let handlerRan = false;
      try {
        result = await handler(context);
        handlerRan = true;
      } catch (e) {
        handlerErr = e;
      }
      const record = async (): Promise<void> => {
        if (handlerRan) {
          await queue.completeJob(
            job.id,
            lockToken,
            result != null ? (typeof result === 'object' ? result as Record<string, unknown> : { value: result }) : undefined,
          );
          return;
        }
        // Worker-parity outcome routing (#4217 CDX-3 + #4194):
        //   - RateLeaseUnavailableError → delayed requeue WITHOUT burning an
        //     attempt (mirrors worker.ts's releaseLeaseFullJob path; matters
        //     with concurrent loops against a shared lease cap).
        //   - UnrecoverableError → dead immediately (retry is provably futile
        //     — e.g. all-writes-failed accounting; pre-fix the drain retried
        //     these to exhaustion, exactly the incident-churn #4217
        //     describes).
        //   - Timeout stays terminal (handleTimeouts parity), never delayed.
        if (handlerErr instanceof RateLeaseUnavailableError) {
          const leaseBackoffMs = leaseFullBackoffMs();
          const released = await queue.releaseLeaseFullJob(
            job.id, lockToken, handlerErr.message, leaseBackoffMs,
          );
          if (released) return;
          // Lock-token mismatch (stall sweep won) — fall through to failJob,
          // which no-ops under the same fence.
        }
        const timedOut = abort.signal.aborted;
        const errorText = timedOut ? 'timeout exceeded' : (handlerErr instanceof Error ? handlerErr.message : String(handlerErr));
        const isUnrecoverable = handlerErr instanceof UnrecoverableError;
        const attemptsExhausted = job.attempts_made + 1 >= job.max_attempts;
        await queue.failJob(
          job.id,
          lockToken,
          errorText,
          timedOut || isUnrecoverable || attemptsExhausted ? 'dead' : 'delayed',
          0,
        );
      };
      try {
        try {
          await record();
        } catch (recordErr) {
          if (!isRetryableConnError(recordErr)) throw recordErr;
          const msg = recordErr instanceof Error ? recordErr.message : String(recordErr);
          process.stderr.write(`[dream] inline drain: recording job ${job.id} outcome hit a connection error; reconnecting and retrying once: ${msg}\n`);
          await reconnectAfterConnectionError(engine, 'inline-record', recordErr);
          try {
            await record();
          } catch (retryErr) {
            // Leave the row to the loop's own handleStalled: the claim lock
            // stops renewing (finally clears renewTimer), expires within
            // lockMs, and the next iteration requeues it on a live pool.
            const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
            process.stderr.write(`[dream] inline drain: outcome recording retry for job ${job.id} also failed (${retryMsg}); leaving the row for stall requeue\n`);
          }
        }
      } finally {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (keepalive) clearInterval(keepalive);
        clearInterval(renewTimer);
      }
    }
  } catch (e) {
    // Loop-level fatal (non-retryable conn error, unrecoverable record
    // failure). Signal siblings to stop claiming NEW children after their
    // current one — the phase is going to fail with this cause anyway;
    // letting siblings churn through the rest of the queue first would just
    // delay the report (OV-6).
    poolAbort?.abort(e);
    throw e;
  }
}
