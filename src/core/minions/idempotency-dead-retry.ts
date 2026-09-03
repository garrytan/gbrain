/**
 * Bounded replay for idempotency-keyed terminal failures.
 *
 * `queue.add()` frees the idempotency slot of a dead/cancelled job so a fresh
 * attempt can be inserted (#2252 / #3306). That release is per-submit and has
 * no counter, so an input that fails *permanently* is re-dispatched on every
 * caller pass, forever: `max_attempts` cannot bound it because it is a
 * per-row column and each release manufactures a new row with
 * `attempts_made = 0`.
 *
 * This module keeps the #3306 behaviour and adds the missing bound: after
 * `limit` consecutive dead dispatches for one key, the key is retained on the
 * last dead row instead of being released, so the next submit coalesces onto
 * that row rather than minting another job.
 *
 * No schema change: released keys are retained in job `data` for history (the
 * `__`-prefixed embedded-metadata convention already used by `__param_hash`),
 * and a latest-to-oldest status walk resets at any non-dead outcome.
 */
import type { BrainEngine } from '../engine.ts';

export const IDEMPOTENCY_DEAD_RETRY_LIMIT_CONFIG = 'minions.idempotency_dead_retry_limit';
export const DEFAULT_IDEMPOTENCY_DEAD_RETRY_LIMIT = 3;

export interface IdempotencyDeadRetryBlock {
  jobId: number;
  deadStreak: number;
  limit: number;
  /**
   * The blocked row's `data` as stored by the marker write. `queue.add()` reads
   * the row before this UPDATE runs, so without handing the post-write value
   * back the returned job would not carry the marker it is being blocked by.
   */
  data: Record<string, unknown> | null;
}

export function parseIdempotencyDeadRetryLimit(raw: string | null | undefined): number {
  if (raw == null || raw.trim() === '') return DEFAULT_IDEMPOTENCY_DEAD_RETRY_LIMIT;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return DEFAULT_IDEMPOTENCY_DEAD_RETRY_LIMIT;
  const parsed = Number(trimmed);
  // A limit below two would violate the contract this module preserves: one
  // dead dispatch still earns one fresh dispatch (#3306). Cap pathological
  // values so the history scan below stays bounded.
  if (!Number.isSafeInteger(parsed) || parsed < 2) return DEFAULT_IDEMPOTENCY_DEAD_RETRY_LIMIT;
  return Math.min(parsed, 100);
}

/** Resolve the configured limit. Fail-open to the default on any config error. */
export async function resolveIdempotencyDeadRetryLimit(
  engine: Pick<BrainEngine, 'getConfig'>,
): Promise<number> {
  const raw = await engine.getConfig(IDEMPOTENCY_DEAD_RETRY_LIMIT_CONFIG).catch(() => null);
  return parseIdempotencyDeadRetryLimit(raw);
}

/**
 * Count consecutive dead dispatches for one key, newest first, stopping at the
 * first non-dead row.
 *
 * The two arms are UNIONed rather than OR-ed so the live arm can use the
 * `idempotency_key` unique partial index (a two-column OR defeats it), and the
 * walk is LIMITed to `limit + 1` rows: the caller only needs to know whether
 * the streak reaches `limit`, never its true length.
 */
export async function loadConsecutiveDeadIdempotencyCount(
  engine: Pick<BrainEngine, 'executeRaw'>,
  idempotencyKey: string,
  limit: number = DEFAULT_IDEMPOTENCY_DEAD_RETRY_LIMIT,
): Promise<number> {
  const rows = await engine.executeRaw<{ status: string }>(
    `SELECT status FROM (
         SELECT status, created_at, id FROM minion_jobs WHERE idempotency_key = $1
         UNION ALL
         SELECT status, created_at, id FROM minion_jobs
          WHERE data->>'__released_idempotency_key' = $1
       ) history
      ORDER BY created_at DESC, id DESC
      LIMIT $2`,
    [idempotencyKey, limit + 1],
  );
  let streak = 0;
  for (const row of rows) {
    if (row.status !== 'dead') break;
    streak++;
  }
  return streak;
}

/**
 * Called by `queue.add()` while the current terminal row is in hand.
 *
 * - `cancelled` always releases, and remains a streak-breaking history row
 * - `dead` below `limit` releases, exactly as #3306 made it
 * - `dead` at/above `limit` retains the unique key and gets an observable
 *   `__idempotency_retry_blocked` marker; the caller coalesces onto it
 *
 * Escape hatches for a blocked key, both pre-existing: `jobs retry <id>`
 * (flips the row out of `dead`, breaking the streak) and `jobs cancel <id>`
 * (releases the key outright).
 */
export async function releaseOrBlockTerminalIdempotencyKey(
  engine: Pick<BrainEngine, 'executeRaw'>,
  args: { jobId: number; status: 'dead' | 'cancelled'; idempotencyKey: string; limit: number },
): Promise<IdempotencyDeadRetryBlock | null> {
  if (args.status === 'dead') {
    const deadStreak = await loadConsecutiveDeadIdempotencyCount(
      engine, args.idempotencyKey, args.limit,
    );
    if (deadStreak >= args.limit) {
      const updated = await engine.executeRaw<{ data: Record<string, unknown> | null }>(
        `UPDATE minion_jobs
            SET data = jsonb_set(
                  COALESCE(data, '{}'::jsonb),
                  '{__idempotency_retry_blocked}',
                  jsonb_build_object(
                    'reason', 'dead_streak_limit',
                    'dead_streak', $2::int,
                    'limit', $3::int,
                    'blocked_at', now()
                  ),
                  true
                ),
                updated_at = now()
          WHERE id = $1
      RETURNING data`,
        [args.jobId, deadStreak, args.limit],
      );
      return {
        jobId: args.jobId, deadStreak, limit: args.limit,
        data: updated[0]?.data ?? null,
      };
    }
  }

  await engine.executeRaw(
    `UPDATE minion_jobs
        SET data = jsonb_set(
              COALESCE(data, '{}'::jsonb),
              '{__released_idempotency_key}',
              to_jsonb($2::text),
              true
            ),
            idempotency_key = NULL,
            updated_at = now()
      WHERE id = $1`,
    [args.jobId, args.idempotencyKey],
  );
  return null;
}
