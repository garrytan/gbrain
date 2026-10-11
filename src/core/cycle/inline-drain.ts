/**
 * In-process drain for Dream's private child queue.
 *
 * PGLite cannot run a second Worker process while the owning process holds the
 * embedded database lock. Draining the private queue here also avoids a
 * Postgres parent/child worker-slot deadlock. This compatibility port keeps
 * PMBrain's existing subagent handler and queue state machine unchanged.
 */

import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { MinionQueue } from '../minions/queue.ts';
import { makeSubagentHandler, RateLeaseUnavailableError } from '../minions/handlers/subagent.ts';
import type { MinionHandler, MinionJobContext } from '../minions/types.ts';
import { UnrecoverableError } from '../minions/types.ts';
import { combineAbortSignals, throwIfAborted } from '../abort-check.ts';

export const INLINE_LOCK_MS = 30_000;

export async function runSubagentsInline(
  engine: BrainEngine,
  queue: MinionQueue,
  queueName: string,
  yieldDuringPhase?: () => Promise<void>,
  handler: MinionHandler = makeSubagentHandler({ engine }),
  lockMs = INLINE_LOCK_MS,
  signal?: AbortSignal,
): Promise<void> {
  while (true) {
    throwIfAborted(signal, '[dream] inline drain');
    await queue.promoteDelayed();
    await queue.handleStalled();
    await queue.handleTimeouts();
    await queue.handleWallClockTimeouts(lockMs);

    const lockToken = randomUUID();
    const job = await queue.claim(lockToken, lockMs, queueName, ['subagent']);
    if (!job) {
      const rows = await engine.executeRaw<{ count: number | string }>(
        `SELECT count(*) AS count
           FROM minion_jobs
          WHERE queue = $1
            AND status IN ('active', 'waiting', 'delayed')`,
        [queueName],
      );
      if (Number(rows[0]?.count ?? 0) === 0) return;
      await new Promise(resolve => setTimeout(resolve, 100));
      continue;
    }

    const abort = new AbortController();
    const shutdown = new AbortController();
    const context: MinionJobContext = {
      id: job.id,
      name: job.name,
      data: job.data,
      attempts_made: job.attempts_made,
      signal: combineAbortSignals(abort.signal, signal),
      deadlineAtMs: job.timeout_at?.getTime() ?? null,
      shutdownSignal: shutdown.signal,
      updateProgress: async progress => {
        await queue.updateProgress(job.id, lockToken, progress);
      },
      updateTokens: async tokens => {
        await queue.updateTokens(job.id, lockToken, tokens);
      },
      log: async message => {
        const value = typeof message === 'string' ? message : JSON.stringify(message);
        await engine.executeRaw(
          `UPDATE minion_jobs
              SET stacktrace = COALESCE(stacktrace, '[]'::jsonb) || to_jsonb($1::text),
                  updated_at = now()
            WHERE id = $2 AND status = 'active' AND lock_token = $3`,
          [value, job.id, lockToken],
        );
      },
      isActive: async () => {
        const rows = await engine.executeRaw<{ id: number }>(
          `SELECT id FROM minion_jobs
            WHERE id = $1 AND status = 'active' AND lock_token = $2`,
          [job.id, lockToken],
        );
        return rows.length > 0;
      },
      readInbox: () => queue.readInbox(job.id, lockToken),
    };

    const timeoutMs = job.timeout_at
      ? Math.max(0, job.timeout_at.getTime() - Date.now())
      : job.timeout_ms;
    const timeout = timeoutMs != null
      ? setTimeout(() => abort.abort(new Error('timeout')), timeoutMs)
      : null;
    const renew = setInterval(() => {
      void queue.renewLock(job.id, lockToken, lockMs).then(ok => {
        if (!ok && !abort.signal.aborted) abort.abort(new Error('lock-renewal-failed'));
      }).catch(() => { /* best-effort; the next tick retries */ });
    }, Math.max(1000, Math.floor(lockMs / 3)));
    const keepalive = yieldDuringPhase
      ? setInterval(() => { void yieldDuringPhase().catch(() => { /* best-effort */ }); }, 60_000)
      : null;

    try {
      const result = await handler(context);
      await queue.completeJob(
        job.id,
        lockToken,
        result != null
          ? (typeof result === 'object' ? result as Record<string, unknown> : { value: result })
          : undefined,
      );
    } catch (error) {
      if (error instanceof RateLeaseUnavailableError) {
        await queue.releaseLeaseFullJob(
          job.id,
          lockToken,
          error.message,
          1000 + Math.floor(Math.random() * 2000),
        );
      } else {
        const timedOut = abort.signal.aborted&&abort.signal.reason instanceof Error&&abort.signal.reason.message==='timeout';
        const attemptsExhausted = job.attempts_made + 1 >= job.max_attempts;
        await queue.failJob(
          job.id,
          lockToken,
          timedOut ? (job.data.ingest_context?'ingest_provider_timeout: entity subtask timeout exceeded':'timeout exceeded') : error instanceof Error ? error.message : String(error),
          timedOut || error instanceof UnrecoverableError || attemptsExhausted ? 'dead' : 'delayed',
          0,
        );
      }
    } finally {
      if (timeout) clearTimeout(timeout);
      clearInterval(renew);
      if (keepalive) clearInterval(keepalive);
    }
  }
}
