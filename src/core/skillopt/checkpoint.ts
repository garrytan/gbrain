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
 *    next_epoch, next_step,          // authoritative resume cursor
 *    run_spec,                       // what --resume must match
 *    tally,                          // reflect usability + early-stop counter
 *    cumulative_cost_usd,              // every segment of the run
 *    models_used, models_used_scope,   // #5585 ledger rows, every segment
 *    started_at, last_updated_at
 *  }
 *
 * Atomic write via .tmp + rename. The cursor advances after EVERY completed
 * step (accepted, rejected or no candidate) and cost/tally are persisted on
 * completed steps AND handled aborts, so --resume <run_id> continues at the
 * first step that did not complete. Legacy checkpoints (no cursor) convert via
 * `resumeCursor`. `assertResumeCompatible` refuses a resume whose benchmark,
 * held-out set, split, target/judge model or batch size changed, or whose
 * mutate policy would widen (no-mutate -> mutate); the optimizer model, reflect
 * cap and cost cap may change.
 *
 * Accounting (#5585): `bankAccounting` folds this segment's tracker snapshot
 * onto what earlier segments banked, so a resumed run's receipt reports the
 * whole run. A legacy checkpoint without ledger rows marks the resumed run's
 * `models_used` as `since_resume`.
 *
 * 7-day GC: stale checkpoints older than 7 days are removed at the start of
 * the dream cycle's skillopt phase.
 */

import { assertLegacySkillFilesystemWrite } from '../skillpack/writer-guard.ts';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { errorFor } from '../errors.ts';
import { atomicWrite } from './apply-edits.ts';
import type { BudgetSnapshot } from '../budget/budget-tracker.ts';
import { buildModelsUsed, type ModelUsageRow } from '../budget/models-used.ts';

const CHECKPOINT_SCHEMA = 1;

/** The run's reproducible shape: resume refusal + the printed resume command read it. */
export interface RunSpec {
  skills_dir: string;
  benchmark_path: string;
  benchmark_sha8: string;
  held_out_path: string | null;
  held_out_sha8: string | null;
  split: [number, number, number];
  /** Effective mutate decision (false for --no-mutate and bundled-without-allow). */
  mutate: boolean;
  no_mutate: boolean;
  allow_mutate_bundled: boolean;
  bootstrap_reviewed: boolean;
  optimizer_model: string;
  target_model: string;
  judge_model: string;
  epochs: number;
  batch_size: number;
  lr: number;
  lr_schedule: 'cosine' | 'linear' | 'constant';
  reflect_max_tokens: number;
}

/** Whole-run optimizer-reply accounting (survives resume). */
export interface ReflectTally {
  /** Optimizer calls attempted (reflect + one-shot). */
  reflect_calls: number;
  /** Calls whose reply was usable (edits or a deliberate empty). */
  usable_replies: number;
  /** Consecutive steps whose every optimizer call errored. */
  unusable_streak: number;
  /** Steps whose candidate was accepted (SKILL.md / proposed.md truth). */
  accepted_steps: number;
  reflect_errors: string[];
  invalid_edits_dropped: number;
}

export function emptyTally(): ReflectTally {
  return { reflect_calls: 0, usable_replies: 0, unusable_streak: 0, accepted_steps: 0, reflect_errors: [], invalid_edits_dropped: 0 };
}

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
  /** Fully-completed epochs, and the last completed step inside the current epoch. */
  last_completed_epoch: number;
  last_completed_step: number;
  /** First (epoch, step) not yet completed. Absent on legacy checkpoints. */
  next_epoch?: number;
  next_step?: number;
  run_spec?: RunSpec;
  tally?: ReflectTally;
  cumulative_cost_usd: number;
  /** Ledger rows banked across segments. Absent on legacy checkpoints. */
  models_used?: ModelUsageRow[];
  models_used_scope?: ModelsUsedScope;
  started_at: string;
  last_updated_at: string;
}

export type ModelsUsedScope = 'full_run' | 'since_resume';

/** What earlier segments of this run banked before the current tracker started. */
export interface PriorSegments {
  costUsd: number;
  rows: ModelUsageRow[];
  scope: ModelsUsedScope;
}

export function priorSegments(cp: RunCheckpoint | null): PriorSegments {
  if (!cp) return { costUsd: 0, rows: [], scope: 'full_run' };
  return {
    costUsd: cp.cumulative_cost_usd,
    rows: cp.models_used ?? [],
    scope: cp.models_used ? (cp.models_used_scope ?? 'full_run') : 'since_resume',
  };
}

/** Bank spend + ledger rows (prior segments + this one) on completed steps and handled aborts. */
export function bankAccounting(cp: RunCheckpoint, prior: PriorSegments, snapshot: BudgetSnapshot): void {
  cp.cumulative_cost_usd = prior.costUsd + snapshot.cumulativeCostUsd;
  cp.models_used = buildModelsUsed(snapshot, prior.rows);
  cp.models_used_scope = prior.scope;
}

/**
 * Where a resumed run continues. Legacy checkpoints recorded only the last
 * completed (epoch, step): step 0 or a full epoch means the next epoch starts;
 * otherwise the same epoch continues at the next step.
 */
export function resumeCursor(cp: RunCheckpoint, stepsPerEpoch: number): { epoch: number; step: number } {
  if (cp.next_epoch !== undefined && cp.next_step !== undefined) return { epoch: cp.next_epoch, step: cp.next_step };
  const e = cp.last_completed_epoch;
  const s = cp.last_completed_step;
  if (s === 0 || s >= stepsPerEpoch) return { epoch: e + 1, step: 1 };
  return { epoch: Math.max(1, e), step: s + 1 };
}

/** Advance the cursor past a completed (epoch, step). */
export function advanceCursor(cp: RunCheckpoint, epoch: number, step: number, stepsPerEpoch: number): void {
  const epochDone = step >= stepsPerEpoch;
  cp.next_epoch = epochDone ? epoch + 1 : epoch;
  cp.next_step = epochDone ? 1 : step + 1;
  cp.last_completed_epoch = epochDone ? epoch : epoch - 1;
  cp.last_completed_step = epochDone ? 0 : step;
}

/** Point the checkpoint's cursor at (epoch, step) as the next step to run. */
export function setCursor(cp: RunCheckpoint, cursor: { epoch: number; step: number }): void {
  cp.next_epoch = cursor.epoch;
  cp.next_step = cursor.step;
  cp.last_completed_epoch = cursor.epoch - 1;
  cp.last_completed_step = cursor.step === 1 ? 0 : cursor.step - 1;
}

/** Move a cursor back `steps` steps, never before epoch 1 step 1. */
export function rewindCursor(
  cursor: { epoch: number; step: number },
  steps: number,
  stepsPerEpoch: number,
): { epoch: number; step: number } {
  if (steps <= 0) return cursor;
  const index = Math.max(0, (cursor.epoch - 1) * stepsPerEpoch + (cursor.step - 1) - steps);
  return { epoch: Math.floor(index / stepsPerEpoch) + 1, step: (index % stepsPerEpoch) + 1 };
}

const RESUME_LOCKED_FIELDS = ['benchmark_sha8', 'held_out_sha8', 'split', 'target_model', 'judge_model', 'batch_size'] as const;

/** Refuse a resume that would change what the checkpoint measured, naming the field. */
export function assertResumeCompatible(cp: RunCheckpoint, current: RunSpec): void {
  const stored = cp.run_spec;
  const refuse = (field: string, was: unknown, now: unknown): never => {
    throw errorFor({
      class: 'ResumeMismatch',
      code: 'resume_spec_mismatch',
      message: `Cannot resume run ${cp.run_id}: ${field} changed (checkpoint ${JSON.stringify(was)}, now ${JSON.stringify(now)}).`,
      hint: `Resume with the original settings (the run's resume command reproduces them), or start a fresh run without --resume.`,
    });
  };
  if (!stored) {
    if (cp.benchmark_sha8 !== current.benchmark_sha8) refuse('benchmark_sha8', cp.benchmark_sha8, current.benchmark_sha8);
    return;
  }
  for (const field of RESUME_LOCKED_FIELDS) {
    if (JSON.stringify(stored[field]) !== JSON.stringify(current[field])) refuse(field, stored[field], current[field]);
  }
  if (!stored.mutate && current.mutate) refuse('mutate policy', 'no-mutate', 'mutate');
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
  assertLegacySkillFilesystemWrite(p);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const payload = { ...cp, last_updated_at: new Date().toISOString() };
  atomicWrite(p, JSON.stringify(payload, null, 2) + '\n');
}

export function deleteCheckpoint(skillsDir: string, skillName: string, runId: string): void {
  const p = checkpointPath(skillsDir, skillName, runId);
  assertLegacySkillFilesystemWrite(p);
  try { fs.unlinkSync(p); } catch { /* ignore */ }
}

/**
 * GC stale checkpoints older than `maxAgeDays` (default 7). Called at the
 * start of the dream cycle's skillopt phase. Returns the count of removed files.
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
      assertLegacySkillFilesystemWrite(p);
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
