/**
 * Shared MinionJobContext builder (issue #5 — per-job process isolation).
 *
 * Extracted verbatim from MinionWorker.executeJob so the same DB-backed
 * context wiring serves BOTH execution modes:
 *
 *   inline  — the worker builds it against its own engine/queue;
 *   process — `gbrain jobs run-child` builds it against the CHILD's engine
 *             (child-owns-engine design: every write below is token-fenced,
 *             so a reclaimed job's orphan child degrades to a no-op writer).
 *
 * Behavioral no-op for the inline path.
 */

import type { BrainEngine } from '../engine.ts';
import type { MinionQueue } from './queue.ts';
import type { MinionJob, MinionJobContext, TokenUpdate } from './types.ts';

export function buildJobContext(
  engine: BrainEngine,
  queue: MinionQueue,
  job: MinionJob,
  lockToken: string,
  signal: AbortSignal,
  shutdownSignal: AbortSignal,
): MinionJobContext {
  return {
    id: job.id,
    name: job.name,
    data: job.data,
    attempts_made: job.attempts_made,
    signal,
    deadlineAtMs: job.timeout_at != null ? job.timeout_at.getTime() : null,
    shutdownSignal,
    updateProgress: async (progress: unknown) => {
      await queue.updateProgress(job.id, lockToken, progress);
    },
    updateTokens: async (tokens: TokenUpdate) => {
      await queue.updateTokens(job.id, lockToken, tokens);
    },
    log: async (message: string | Record<string, unknown>) => {
      const value = typeof message === 'string' ? message : JSON.stringify(message);
      await engine.executeRaw(
        `UPDATE minion_jobs SET stacktrace = COALESCE(stacktrace, '[]'::jsonb) || to_jsonb($1::text),
          updated_at = now()
         WHERE id = $2 AND status = 'active' AND lock_token = $3`,
        [value, job.id, lockToken]
      );
    },
    isActive: async () => {
      const rows = await engine.executeRaw<{ id: number }>(
        `SELECT id FROM minion_jobs WHERE id = $1 AND status = 'active' AND lock_token = $2`,
        [job.id, lockToken]
      );
      return rows.length > 0;
    },
    readInbox: async () => {
      return queue.readInbox(job.id, lockToken);
    },
  };
}
