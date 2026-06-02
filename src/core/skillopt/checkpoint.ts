/**
 * SkillOpt run checkpoint. Lightweight per-run state for --resume support.
 *
 * Persists at `skills/<name>/skillopt/checkpoint-<run_id>.json`:
 *  {
 *    schema: 1,
 *    run_id, skill, skill_sha8, benchmark_sha8,
 *    epochs, batch_size, lr, lr_schedule,
 *    best_sel_score, best_skill_text,
 *    last_completed_epoch, last_completed_step,
 *    cumulative_cost_usd,
 *    started_at, last_updated_at
 *  }
 *
 * Atomic write via .tmp + rename. On --resume <run_id>, the orchestrator
 * reads this file and skips epochs/steps that completed.
 *
 * 7-day GC: stale checkpoints older than 7 days are removed by the dream
 * cycle's purge phase (T6 wiring).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { atomicWrite } from './apply-edits.ts';

const CHECKPOINT_SCHEMA = 1;

export interface RunCheckpoint {
  schema: 1;
  run_id: string;
  skill: string;
  skill_sha8: string;
  benchmark_sha8: string;
  optimizer_model: string;
  target_model: string;
  judge_model: string;
  epochs: number;
  batch_size: number;
  lr: number;
  lr_schedule: 'cosine' | 'linear' | 'constant';
  /** Highest sel-score achieved so far across the run. */
  best_sel_score: number;
  /** The skill text that produced best_sel_score. */
  best_skill_text: string;
  /** Most recent successfully-completed (epoch, step). 0/0 = nothing yet. */
  last_completed_epoch: number;
  last_completed_step: number;
  cumulative_cost_usd: number;
  started_at: string;
  last_updated_at: string;
}

export function checkpointPath(skillsDir: string, skillName: string, runId: string): string {
  return path.join(skillsDir, skillName, 'skillopt', `checkpoint-${runId}.json`);
}

export function loadCheckpoint(skillsDir: string, skillName: string, runId: string): RunCheckpoint | null {
  const p = checkpointPath(skillsDir, skillName, runId);
  if (!fs.existsSync(p)) return null;
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw) as RunCheckpoint;
    if (parsed.schema !== CHECKPOINT_SCHEMA) return null;
    return parsed;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[skillopt] checkpoint unreadable (${msg}); starting fresh\n`);
    return null;
  }
}

export function saveCheckpoint(skillsDir: string, skillName: string, cp: RunCheckpoint): void {
  const p = checkpointPath(skillsDir, skillName, cp.run_id);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const payload = { ...cp, last_updated_at: new Date().toISOString() };
  atomicWrite(p, JSON.stringify(payload, null, 2) + '\n');
}

export function deleteCheckpoint(skillsDir: string, skillName: string, runId: string): void {
  const p = checkpointPath(skillsDir, skillName, runId);
  try { fs.unlinkSync(p); } catch { /* ignore */ }
}

/**
 * GC stale checkpoints older than `maxAgeDays` (default 7). Called by the
 * dream cycle's purge phase. Returns the count of removed files.
 */
export function gcStaleCheckpoints(skillsDir: string, maxAgeDays: number = 7): number {
  if (!fs.existsSync(skillsDir)) return 0;
  const cutoffMs = Date.now() - maxAgeDays * 86400 * 1000;
  let removed = 0;
  for (const skillName of safeReaddir(skillsDir)) {
    const dir = path.join(skillsDir, skillName, 'skillopt');
    if (!fs.existsSync(dir)) continue;
    for (const entry of safeReaddir(dir)) {
      if (!entry.startsWith('checkpoint-') || !entry.endsWith('.json')) continue;
      const p = path.join(dir, entry);
      try {
        const stat = fs.statSync(p);
        if (stat.mtimeMs < cutoffMs) {
          fs.unlinkSync(p);
          removed += 1;
        }
      } catch { /* ignore */ }
    }
  }
  return removed;
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}
