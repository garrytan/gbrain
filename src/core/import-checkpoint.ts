import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'fs';
import { relative, isAbsolute } from 'path';

/**
 * Path-based import checkpoint.
 *
 * Pre-v0.33.2 brains used a positional checkpoint (`processedIndex` into a
 * sorted file array). That model was broken in three ways under any non-
 * sequential execution:
 *
 *   1. Parallel workers — `processed++` fires on completion, not dispatch,
 *      so a slow worker on `files[0]` + three fast completions writes
 *      `processedIndex=3`. Crash-resume slices `files.slice(3)` and the
 *      slow file is silently lost.
 *   2. Failed files — error path still bumped the same counter, so failures
 *      pushed the checkpoint past them and the next run skipped them
 *      forever (line 268's "delete on clean exit" only fires when
 *      errors === 0; a single failure preserves the bad checkpoint).
 *   3. Sort-order changes — flipping the walk order makes positional
 *      indices from prior runs mean different files.
 *
 * Path-based resume fixes all three: a file is "done" only when its
 * `processFile` returns successfully, the completed set is keyed by the
 * relative path string (sort-order-agnostic), and failed files never
 * enter the set.
 */
export interface ImportCheckpoint {
  /** Absolute brain directory the checkpoint was created against. Mismatch on resume → discard. */
  dir: string;
  /**
   * Paths (relative to `dir`) that completed successfully or were unchanged.
   * Stored as a sorted array for serialization; loaded into a Set at runtime.
   */
  completedPaths: string[];
  /** ISO 8601, diagnostic only. */
  timestamp: string;
}

const OLD_FORMAT_LOG = 'Older checkpoint format detected — re-walking (cheap via content_hash)';

/**
 * Load a checkpoint and verify it's compatible with the current run.
 *
 * Returns null when:
 *   - the file is missing
 *   - the JSON is malformed
 *   - the recorded `dir` doesn't match the current `dir`
 *   - the payload is a pre-v0.33.2 positional checkpoint (logs to stderr
 *     so users see why a partial import is re-walking)
 *   - `completedPaths` is missing or not an array of strings
 */
export function loadCheckpoint(path: string, currentDir: string): ImportCheckpoint | null {
  if (!existsSync(path)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;

  // Pre-v0.33.2 positional format: had `processedIndex`, no `completedPaths`.
  // Detect via the absence of the new field — discard and surface why.
  if (!Array.isArray(obj.completedPaths)) {
    if (typeof obj.processedIndex === 'number') {
      console.error(OLD_FORMAT_LOG);
    }
    return null;
  }

  if (typeof obj.dir !== 'string') return null;
  if (obj.dir !== currentDir) return null;
  if (typeof obj.timestamp !== 'string') return null;
  if (!obj.completedPaths.every((p): p is string => typeof p === 'string')) return null;

  return {
    dir: obj.dir,
    completedPaths: obj.completedPaths,
    timestamp: obj.timestamp,
  };
}

/**
 * Write a checkpoint atomically (write-to-tmp + rename) so a crash mid-write
 * can never leave a partially-written JSON file that breaks the next resume.
 *
 * Failures are non-fatal — the caller logs nothing and the import continues.
 * A missing checkpoint just means the next run re-walks from zero, which
 * is cheap because `importFile` short-circuits unchanged files via
 * `content_hash`.
 */
export function saveCheckpoint(path: string, cp: ImportCheckpoint): void {
  try {
    const tmp = `${path}.tmp`;
    // Sort for stable serialization — keeps diffs across snapshots minimal
    // and tests deterministic.
    const payload: ImportCheckpoint = {
      dir: cp.dir,
      completedPaths: [...cp.completedPaths].sort(),
      timestamp: cp.timestamp,
    };
    writeFileSync(tmp, JSON.stringify(payload));
    renameSync(tmp, path);
  } catch {
    /* non-fatal: lost checkpoint just means re-walk on next run */
  }
}

/**
 * Filter `allFiles` to those NOT already in the completed set.
 *
 * `allFiles` may contain absolute paths (from the recursive walker) or
 * already-relative paths (from tests). `completed` is always relative to
 * `dir`. Normalize each file to relative form before lookup.
 *
 * Pure function — no fs access. Test surface for the resume semantics.
 */
export function resumeFilter(
  allFiles: string[],
  dir: string,
  completed: Set<string>,
): string[] {
  if (completed.size === 0) return allFiles;
  return allFiles.filter((p) => {
    const rel = isAbsolute(p) ? relative(dir, p) : p;
    return !completed.has(rel);
  });
}

/**
 * Convenience for callers: remove a checkpoint file. Wraps the existing
 * cleanup-on-clean-exit site in import.ts. Non-fatal.
 */
export function clearCheckpoint(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    /* non-fatal */
  }
}
