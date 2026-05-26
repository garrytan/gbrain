/**
 * v0.37.x — doctor --remediate checkpoint (A4 amended).
 *
 * When `gbrain doctor --remediate --max-cost N` blows past the cap mid-run
 * (BudgetTracker throws BudgetExhausted via the gateway-layer
 * AsyncLocalStorage), the runRemediate orchestrator persists what's been
 * completed so the user can continue with `gbrain doctor --remediate --resume`.
 *
 * Checkpoint file: `~/.gbrain/remediation/<plan_hash>.json`
 *   - plan_hash = sha256(JSON.stringify(sorted recommendation ids)).slice(0,16)
 *   - schema_version: 1
 *
 * Best-effort write: a disk-full checkpoint never blocks the throw; we'd
 * rather surface the BudgetExhausted than swallow it because the audit
 * sidecar failed.
 */

import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gbrainPath } from './config.ts';

export interface RemediationCheckpoint {
  schema_version: 1;
  plan_hash: string;
  doctor_run_id: string;
  target_score: number;
  started_at: string;
  completed: Array<{
    id: string;
    job: string;
    idempotency_key?: string;
    status: string;
    job_id?: number | null;
  }>;
  aborted_at: string;
  abort_reason: 'budget_exhausted' | 'manual' | 'error';
  budget_snapshot?: {
    spent: number;
    cap: number;
    reason: string;
    model_id?: string;
  };
}

function checkpointDir(): string {
  return gbrainPath('remediation');
}

export function computePlanHash(recommendationIds: string[]): string {
  const sorted = [...recommendationIds].sort();
  const sha = createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
  return sha.slice(0, 16);
}

export function checkpointPath(planHash: string): string {
  return join(checkpointDir(), `${planHash}.json`);
}

export function saveRemediationCheckpoint(cp: RemediationCheckpoint): void {
  try {
    mkdirSync(checkpointDir(), { recursive: true });
    const path = checkpointPath(cp.plan_hash);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(cp, null, 2));
    // Atomic rename via fs.renameSync — Node guarantees POSIX atomicity on same-fs renames.
    const { renameSync } = require('node:fs') as typeof import('node:fs');
    renameSync(tmp, path);
  } catch (err) {
    process.stderr.write(`[remediate] checkpoint write failed: ${String(err)}\n`);
  }
}

export function loadRemediationCheckpoint(planHash: string): RemediationCheckpoint | null {
  const path = checkpointPath(planHash);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as RemediationCheckpoint;
    if (parsed.schema_version !== 1) {
      process.stderr.write(`[remediate] checkpoint ${planHash} has schema_version ${parsed.schema_version}; ignoring.\n`);
      return null;
    }
    return parsed;
  } catch (err) {
    process.stderr.write(`[remediate] checkpoint read failed: ${String(err)}\n`);
    return null;
  }
}

/** List checkpoint files mtime-ordered, newest first. Best-effort. */
export function listRemediationCheckpoints(): Array<{ plan_hash: string; mtime: number }> {
  const dir = checkpointDir();
  if (!existsSync(dir)) return [];
  try {
    const entries = readdirSync(dir).filter((f) => f.endsWith('.json'));
    return entries
      .map((f) => {
        try {
          const path = join(dir, f);
          const m = statSync(path).mtimeMs;
          return { plan_hash: f.replace(/\.json$/, ''), mtime: m };
        } catch {
          return null;
        }
      })
      .filter((x): x is { plan_hash: string; mtime: number } => x !== null)
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return [];
  }
}

/** Delete a checkpoint after successful completion. Idempotent. */
export function clearRemediationCheckpoint(planHash: string): void {
  const path = checkpointPath(planHash);
  if (!existsSync(path)) return;
  try {
    unlinkSync(path);
  } catch {
    // Best-effort.
  }
}
