/**
 * #7236: the brain-health read one autopilot tick routes on.
 *
 * `engine.getHealth()` aggregates every content_chunks row (its `chunk_pages`
 * CTE has no row filter), so on a large brain each call is a full scan. A
 * Minions-dispatch tick reads it once, in `computeAutopilotPlan`, and hands the
 * same snapshot to the daemon's adaptive interval instead of reading it again;
 * the dispatch tick only enqueues jobs, so the brain the interval would have
 * graded is the one the plan just graded. The inline path still reads it after
 * its cycle, once.
 *
 * On Postgres the read runs in one transaction with a transaction-local
 * `statement_timeout` (it holds through a transaction-mode pooler, the same
 * bound `persistence/bounded-reads.ts` relies on), so every statement in it
 * ends on the server at AUTOPILOT_HEALTH_TIMEOUT_MS. A read the server ends
 * there (57014, or 55P03 from a shorter session lock_timeout) is reported as
 * degraded and returns null: the tick then knows no score, so it neither
 * sleeps as healthy nor doubles its interval, and the timeout is not counted
 * as a failed cycle. Any other error still throws. PGLite has one in-process
 * connection and no other session to wait on, so its read is unbounded.
 */
import type { BrainEngine } from '../core/engine.ts';
import type { BrainHealth } from '../core/types.ts';
import { isStatementTimeout } from '../core/persistence/bounded-reads.ts';

export const AUTOPILOT_HEALTH_TIMEOUT_MS = 120_000;

/** The tick's health snapshot, or null when the bounded read timed out (degraded; logged here). */
export async function readTickHealth(engine: BrainEngine, jsonMode: boolean, timeoutMs = AUTOPILOT_HEALTH_TIMEOUT_MS): Promise<BrainHealth | null> {
  try {
    if (engine.kind !== 'postgres') return await engine.getHealth();
    return await engine.transaction(async (tx) => {
      await tx.executeRaw(`SET LOCAL statement_timeout = ${Math.max(1, Math.floor(timeoutMs))}`);
      return tx.getHealth();
    });
  } catch (error) {
    if (!isStatementTimeout(error)) throw error;
    const reason = `the brain health aggregate did not finish within ${timeoutMs} ms (SQLSTATE ${error.code})`;
    process.stderr.write((jsonMode
      ? JSON.stringify({ event: 'health_degraded', reason, sqlstate: error.code, timeout_ms: timeoutMs })
      : `[health] degraded: ${reason}; brain score unknown this tick`) + '\n');
    return null;
  }
}
