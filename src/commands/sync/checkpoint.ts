/** Resumable incremental sync checkpoint keys and flush/yield cadence knobs. */
import { syncFingerprint, type OpCheckpointKey } from '../../core/op-checkpoint.ts';

/**
 * v0.42.x (#1794) -- resumable incremental sync checkpoint.
 *
 * Two op-checkpoint rows back one resumable incremental sync, both keyed by
 * the same syncFingerprint(sourceId, lastCommit):
 *   - op 'sync'        -> completed_keys = repo-relative file paths drained
 *   - op 'sync-target' -> completed_keys = [pinnedTargetCommit]
 *
 * Splitting the pinned target into its own row keeps the path set free of any
 * sentinel that could collide with a real filename, and both rows clear
 * together on full completion. The fingerprint encodes ONLY (sourceId,
 * lastCommit) -- never the target or live HEAD -- so the checkpoint survives
 * every killed-and-resumed run while lastCommit..HEAD grows underneath it.
 */
const SYNC_CKPT_OP = 'sync';
const SYNC_TARGET_OP = 'sync-target';

export function syncCheckpointKeys(
  sourceId: string | undefined,
  lastCommit: string,
): { paths: OpCheckpointKey; target: OpCheckpointKey } {
  const fp = syncFingerprint({ sourceId, lastCommit });
  return {
    paths: { op: SYNC_CKPT_OP, fingerprint: fp },
    target: { op: SYNC_TARGET_OP, fingerprint: fp },
  };
}

/**
 * Files flushed to the checkpoint per batch. Larger = fewer JSONB rewrites
 * (less write amplification on huge backlogs) at the cost of more re-done
 * import work on a kill (cheap -- content_hash short-circuits the re-import).
 */
const SYNC_CHECKPOINT_EVERY_DEFAULT = 1000;
const SYNC_CHECKPOINT_SECONDS_DEFAULT = 10;
const SYNC_MAX_CHECKPOINT_FAILURES_DEFAULT = 3;

export function resolveSyncCheckpointEvery(): number {
  const raw = process.env.GBRAIN_SYNC_CHECKPOINT_EVERY;
  if (!raw) return SYNC_CHECKPOINT_EVERY_DEFAULT;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : SYNC_CHECKPOINT_EVERY_DEFAULT;
}

/**
 * v0.42.x (#1794): time-based flush ceiling. Bank the checkpoint at least every
 * N seconds regardless of file throughput, so a kill loses at most ~N seconds of
 * import work even when `checkpointEvery` files haven't accumulated yet.
 */
export function resolveSyncCheckpointSeconds(): number {
  const raw = process.env.GBRAIN_SYNC_CHECKPOINT_SECONDS;
  if (!raw) return SYNC_CHECKPOINT_SECONDS_DEFAULT;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : SYNC_CHECKPOINT_SECONDS_DEFAULT;
}

/**
 * v0.42.x (#1794): how many consecutive checkpoint-flush failures (each already
 * retried by withRetry across the ~12s Supavisor recovery window) before the
 * sync aborts rather than burning CPU importing work it can never bank.
 */
export function resolveSyncMaxCheckpointFailures(): number {
  const raw = process.env.GBRAIN_SYNC_MAX_CHECKPOINT_FAILURES;
  if (!raw) return SYNC_MAX_CHECKPOINT_FAILURES_DEFAULT;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : SYNC_MAX_CHECKPOINT_FAILURES_DEFAULT;
}

const SYNC_YIELD_EVERY_DEFAULT = 64;

/**
 * v0.42.x (#1794): how many imported files between event-loop yields. The import
 * loop is CPU-heavy (chunking, hashing); without yielding it starves the
 * `withRefreshingLock` setInterval heartbeat, so the lock's `last_refreshed_at`
 * never bumps, its TTL lapses mid-run, and a competing launch steals the live
 * lock (the #1794 thrash). A `setImmediate` every N files lets the timer fire.
 */
export function resolveSyncYieldEvery(): number {
  const raw = process.env.GBRAIN_SYNC_YIELD_EVERY;
  if (!raw) return SYNC_YIELD_EVERY_DEFAULT;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : SYNC_YIELD_EVERY_DEFAULT;
}
