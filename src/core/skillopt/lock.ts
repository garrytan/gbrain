/**
 * SkillOpt per-skill DB lock (D14).
 *
 * Thin wrapper around `tryAcquireDbLock` from `src/core/db-lock.ts`. The
 * lock id is `skillopt:<skill-name>` so two concurrent `gbrain skillopt foo`
 * runs serialize cleanly without blocking other skills.
 *
 * Default TTL: 60 minutes — generous for a full epoch run, but the auto-
 * refresh inside `withSkilloptLock` bumps it every 15 minutes so a long
 * run never times out underneath itself.
 *
 * Why a DB lock instead of a filesystem `.lock`:
 *  - Cross-host correct (matters for Conductor workspaces sharing a brain).
 *  - Reuses the existing primitive (same TTL semantics as gbrain sync,
 *    extract-conversation-facts, autopilot cycle).
 *  - Crashed holders auto-release via TTL expiry (no PID-liveness landmine).
 */

import { tryAcquireDbLock, type DbLockHandle } from '../db-lock.ts';
import { errorFor } from '../errors.ts';
import type { BrainEngine } from '../engine.ts';

const DEFAULT_TTL_MINUTES = 60;
const DEFAULT_REFRESH_INTERVAL_MS = 15 * 60 * 1000;

/** Build the lock id for a given skill name. */
export function lockIdFor(skillName: string): string {
  return `skillopt:${skillName}`;
}

/**
 * Acquire a per-skill SkillOpt lock. Returns null when another live holder
 * has the lock. Caller is responsible for releasing via `handle.release()`
 * (use `withSkilloptLock` for try/finally + refresh-loop semantics).
 */
export async function tryAcquireSkilloptLock(
  engine: BrainEngine,
  skillName: string,
  ttlMinutes: number = DEFAULT_TTL_MINUTES,
): Promise<DbLockHandle | null> {
  return tryAcquireDbLock(engine, lockIdFor(skillName), ttlMinutes);
}

/**
 * Run `fn` while holding the per-skill SkillOpt lock with a background
 * refresh loop. Refreshes the TTL every 15 minutes (well under the 60min
 * default TTL so the lock never expires under an active run).
 *
 * Throws a StructuredAgentError with `code: 'lock_busy'` when another
 * live holder has the lock — the user is shown the paste-ready remediation
 * "another run is in progress; wait or check `gbrain jobs supervisor status`".
 *
 * Lock is always released on `fn` completion (success OR throw) via
 * try/finally. The background refresh interval is cleared in the finally.
 */
export async function withSkilloptLock<T>(
  engine: BrainEngine,
  skillName: string,
  fn: (handle: DbLockHandle) => Promise<T>,
  ttlMinutes: number = DEFAULT_TTL_MINUTES,
  refreshIntervalMs: number = DEFAULT_REFRESH_INTERVAL_MS,
): Promise<T> {
  const handle = await tryAcquireSkilloptLock(engine, skillName, ttlMinutes);
  if (handle === null) {
    throw errorFor({
      class: 'LockBusy',
      code: 'lock_busy',
      message: `Another SkillOpt run is in progress for skill '${skillName}'.`,
      hint: `Wait for it to finish, or check 'gbrain jobs supervisor status'. Stale lock holders auto-expire after ${ttlMinutes} minutes.`,
    });
  }

  const refresher = setInterval(() => {
    handle.refresh().catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[skillopt-lock] refresh failed for '${skillName}': ${msg}\n`);
    });
  }, refreshIntervalMs);
  // Don't keep the event loop alive on the refresh timer alone.
  if (typeof refresher.unref === 'function') refresher.unref();

  try {
    return await fn(handle);
  } finally {
    clearInterval(refresher);
    try {
      await handle.release();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[skillopt-lock] release failed for '${skillName}': ${msg}\n`);
    }
  }
}
