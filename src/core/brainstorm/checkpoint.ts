/**
 * v0.37.x — brainstorm checkpoint (P7) with full idea bodies.
 *
 * Contracts (locked by /plan-eng-review):
 *   - TX3 (load-bearing): `completed_crosses` carries FULL idea bodies,
 *     not just counts. ~50KB per run, trivial. Resume merges these into
 *     the new run's ideas array BEFORE the judge runs so the final
 *     BrainstormResult is byte-identical to a clean run.
 *   - TX4: ONE resume flag — `--resume <run_id>` continues any cross not
 *     in completed_crosses. The proposed --retry-failed was dropped per
 *     codex review: failed AND never-attempted crosses both go through
 *     --resume.
 *   - A5 amended: run_id = sha256(question + profile_label +
 *     JSON.stringify(close_slugs.sort()) + JSON.stringify(far_slugs.sort()))
 *     .slice(0,16). NO embedding bits — stable across embedding-model
 *     swaps. 7-day mtime-based GC.
 *
 * Schema bumped to v2 (was 1 in the draft) when ideas were added.
 *
 * Best-effort persistence: a disk-full save logs to stderr and the run
 * continues. Atomic write via .tmp + rename.
 */

import {
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  existsSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gbrainPath } from '../config.ts';

export interface CheckpointIdea {
  text: string;
  cross_id: string;
}

export interface CheckpointCross {
  close_slug: string;
  far_slug: string;
  cross_id: string;
  ideas: CheckpointIdea[];
}

export interface FailedCross {
  close_slug: string;
  far_slug: string;
  error: string;
}

export interface BrainstormCheckpoint {
  schema_version: 2; // TX3 — bumped from 1 when ideas were added
  run_id: string;
  question: string;
  profile_label: string;
  started_at: string;
  /** TX3 load-bearing — each cross's full ideas, not just counts. */
  completed_crosses: CheckpointCross[];
  failed_crosses: FailedCross[];
  judge_done: boolean;
}

const CURRENT_SCHEMA: 2 = 2;
const STALE_MS = 7 * 24 * 60 * 60 * 1000;

function checkpointDir(): string {
  return gbrainPath('brainstorm');
}

function pathForRunId(runId: string): string {
  return join(checkpointDir(), `${runId}.json`);
}

/**
 * A5 amended identity: sha256(question + profile + sort(close) + sort(far))
 * truncated to 16 hex chars. No embedding bits — embedding-model swaps
 * don't break checkpoints.
 */
export function computeRunId(
  question: string,
  profileLabel: string,
  closeSlugs: string[],
  farSlugs: string[],
): string {
  const sortedClose = [...closeSlugs].sort();
  const sortedFar = [...farSlugs].sort();
  const payload = [
    question,
    profileLabel,
    JSON.stringify(sortedClose),
    JSON.stringify(sortedFar),
  ].join('');
  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

export function loadCheckpoint(runId: string): BrainstormCheckpoint | null {
  const path = pathForRunId(runId);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as BrainstormCheckpoint;
    if (parsed.schema_version !== CURRENT_SCHEMA) {
      process.stderr.write(
        `[brainstorm] checkpoint ${runId} has schema_version ${parsed.schema_version} (expected ${CURRENT_SCHEMA}); ignoring (fresh start).\n`,
      );
      return null;
    }
    return parsed;
  } catch (err) {
    process.stderr.write(`[brainstorm] checkpoint read failed for ${runId}: ${String(err)}\n`);
    return null;
  }
}

/** Atomic write via .tmp + rename. Best-effort — disk-full doesn't throw. */
export function saveCheckpoint(cp: BrainstormCheckpoint): void {
  try {
    mkdirSync(checkpointDir(), { recursive: true });
    const path = pathForRunId(cp.run_id);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(cp, null, 2));
    renameSync(tmp, path);
  } catch (err) {
    process.stderr.write(`[brainstorm] checkpoint write failed for ${cp.run_id}: ${String(err)}\n`);
  }
}

export function listRuns(): Array<{ run_id: string; question: string; mtime: number }> {
  const dir = checkpointDir();
  if (!existsSync(dir)) return [];
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    const out: Array<{ run_id: string; question: string; mtime: number }> = [];
    for (const f of files) {
      const runId = f.replace(/\.json$/, '');
      const cp = loadCheckpoint(runId);
      if (!cp) continue;
      try {
        const mtime = statSync(join(dir, f)).mtimeMs;
        out.push({ run_id: runId, question: cp.question, mtime });
      } catch {
        // skip
      }
    }
    out.sort((a, b) => b.mtime - a.mtime);
    return out;
  } catch {
    return [];
  }
}

/**
 * GC checkpoints older than `maxAgeDays` (default 7 per A5). Returns the
 * count of files removed. Best-effort; errors are silent — caller (cycle
 * purge phase) wraps in try/catch.
 */
export function gcStaleCheckpoints(maxAgeDays = 7): number {
  const dir = checkpointDir();
  if (!existsSync(dir)) return 0;
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const path = join(dir, f);
      try {
        const m = statSync(path).mtimeMs;
        if (m < cutoff) {
          unlinkSync(path);
          removed++;
        }
      } catch {
        // skip individual file errors
      }
    }
  } catch {
    // dir-level error — return whatever we managed
  }
  return removed;
}

/** Operator escape hatch: skip the 7d staleness gate. */
export function isCheckpointFresh(runId: string, now: number = Date.now()): boolean {
  const path = pathForRunId(runId);
  if (!existsSync(path)) return false;
  try {
    return now - statSync(path).mtimeMs < STALE_MS;
  } catch {
    return false;
  }
}

/** Erase a checkpoint after the run completes cleanly. Idempotent. */
export function clearCheckpoint(runId: string): void {
  const path = pathForRunId(runId);
  if (!existsSync(path)) return;
  try {
    unlinkSync(path);
  } catch {
    // best-effort
  }
}
