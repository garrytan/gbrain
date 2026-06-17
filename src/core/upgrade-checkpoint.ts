/**
 * Upgrade pipeline checkpoint (v0.30.1 Cherry D5 + Codex X2).
 *
 * Persists step-by-step progress through `gbrain post-upgrade` so a partial
 * failure can be resumed via `gbrain upgrade --resume` instead of
 * re-running every step from scratch.
 *
 * Codex X2 fix: checkpoint is bound to the brain it was created for, via
 * a sha256(database_url) hash. brain-registry.ts:300 manages multiple
 * mounted brains; without identity binding, a checkpoint from brain A can
 * be applied against brain B (corruption vector). The validate() helper
 * is the F4 fall-through gate — when called with a no-checkpoint or
 * mismatched-brain state, the upgrade pipeline silently runs the full path.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { gbrainPath, loadConfig } from './config.ts';

export type UpgradeStep = 'pull' | 'install' | 'schema' | 'features' | 'backfills' | 'verify';

export interface UpgradeCheckpoint {
  /** Stable hash of the brain's database_url. Detects multi-brain mismatch (X2). */
  brain_id: string;
  /** ISO 8601 timestamp of when the upgrade started. */
  started_at: string;
  /** Source version (the binary that started the upgrade). */
  from_version: string;
  /** Target version (the binary that's running the pipeline). */
  to_version: string;
  /** Steps that completed successfully. */
  completed_steps: UpgradeStep[];
  /** Step that failed (set on error). */
  failed_step?: UpgradeStep;
  /** Error info from the failed step. */
  failed_step_error?: { message: string; code?: string };
}

const CHECKPOINT_FILENAME = 'upgrade-checkpoint.json';
const ALL_STEPS: UpgradeStep[] = ['pull', 'install', 'schema', 'features', 'backfills', 'verify'];

function checkpointPath(): string {
  return gbrainPath(CHECKPOINT_FILENAME);
}

/**
 * Compute a stable brain identity hash from the database URL. Strips
 * userinfo to avoid creds in the hash input collision space (anyone
 * comparing hashes can't reverse to find a password). Falls back to
 * 'unknown' when no URL is configured.
 */
export function computeBrainId(databaseUrl?: string | null): string {
  if (!databaseUrl) {
    // PGLite or no config — derive from the configured database_path
    // when present, else 'pglite-default'.
    const cfg = loadConfig();
    const path = cfg?.database_path;
    return createHash('sha256').update(`pglite:${path ?? 'default'}`).digest('hex').slice(0, 16);
  }
  // Strip userinfo so the hash is stable across credential rotations.
  const stripped = databaseUrl.replace(/\/\/[^@]*@/, '//');
  return createHash('sha256').update(stripped).digest('hex').slice(0, 16);
}

/**
 * Read the checkpoint from disk. Returns null when missing or unreadable.
 */
export function loadCheckpoint(): UpgradeCheckpoint | null {
  const path = checkpointPath();
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as UpgradeCheckpoint;
    // Defensive: must have brain_id + completed_steps shape.
    if (typeof parsed.brain_id !== 'string') return null;
    if (!Array.isArray(parsed.completed_steps)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeCheckpoint(state: UpgradeCheckpoint): void {
  const path = checkpointPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(state, null, 2), 'utf-8');
  } catch (err) {
    process.stderr.write(`[upgrade-checkpoint] write failed: ${(err as Error).message}\n`);
  }
}

export function clearCheckpoint(): void {
  const path = checkpointPath();
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    /* best-effort */
  }
}

export interface CheckpointValidation {
  valid: boolean;
  /** Reason for invalidation. */
  reason?: 'no_checkpoint' | 'brain_mismatch' | 'malformed' | 'all_complete';
  /** Step to resume at (next un-completed step). */
  resumeAt?: UpgradeStep;
  /** The loaded checkpoint when valid + has unfinished work. */
  checkpoint?: UpgradeCheckpoint;
}

/**
 * Validate a checkpoint against the current brain. Returns:
 *   - valid=false reason=no_checkpoint  → caller falls through to full upgrade (F4)
 *   - valid=false reason=brain_mismatch → operator must --force or remove checkpoint
 *   - valid=false reason=all_complete   → checkpoint is stale; clear it and run full
 *   - valid=true                        → resume from resumeAt
 */
export function validateCheckpoint(currentBrainId: string): CheckpointValidation {
  const checkpoint = loadCheckpoint();
  if (!checkpoint) return { valid: false, reason: 'no_checkpoint' };
  if (checkpoint.brain_id !== currentBrainId) {
    return { valid: false, reason: 'brain_mismatch', checkpoint };
  }
  // Find the first step NOT in completed_steps.
  const nextStep = ALL_STEPS.find(s => !checkpoint.completed_steps.includes(s));
  if (!nextStep) {
    return { valid: false, reason: 'all_complete', checkpoint };
  }
  return { valid: true, resumeAt: nextStep, checkpoint };
}

/**
 * Mark a step complete in-place. Caller writes back via writeCheckpoint().
 */
export function markStepComplete(checkpoint: UpgradeCheckpoint, step: UpgradeStep): UpgradeCheckpoint {
  if (!checkpoint.completed_steps.includes(step)) {
    checkpoint.completed_steps.push(step);
  }
  // Clear failed_step when a step completes successfully (could be a re-run).
  delete checkpoint.failed_step;
  delete checkpoint.failed_step_error;
  return checkpoint;
}

export function markStepFailed(
  checkpoint: UpgradeCheckpoint,
  step: UpgradeStep,
  err: Error,
): UpgradeCheckpoint {
  checkpoint.failed_step = step;
  checkpoint.failed_step_error = {
    message: err.message,
    code: (err as { code?: string }).code,
  };
  return checkpoint;
}

export const ALL_UPGRADE_STEPS = ALL_STEPS;
