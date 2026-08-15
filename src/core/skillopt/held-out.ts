/**
 * SkillOpt held-out real-user test set (F11).
 *
 * Even with the validation gate (D12) + bundled-skill gate (D16), a skill
 * optimized against its own benchmark may regress on real user workflows.
 * F11 adds an OPTIONAL independent signal:
 *
 *  1. Capture infrastructure: opt-in via `gbrain config set
 *     skillopt.capture_enabled true`. Real production rollouts of the
 *     skill get appended as JSONL rows to
 *     `~/.gbrain/skillopt-captures/<skill>/<run>.jsonl`.
 *
 *  2. Held-out validation gate: when `--held-out <path>` is passed to
 *     `gbrain skillopt`, the orchestrator runs the candidate skill
 *     against the held-out set BEFORE committing the mutation. If the
 *     candidate's held-out score is BELOW baseline, the mutation is
 *     refused (returns 'no_improvement' even if D_sel was happy).
 *
 *  3. `--allow-mutate-bundled` for bundled skills requires `--held-out
 *     <path>` AND a passing held-out gate. Closes the "benchmark gaming
 *     hole" codex identified.
 *
 * Held-out format: same JSONL shape as skillopt-benchmark.jsonl (task_id,
 * task, judge). The judge MAY be `kind: 'rule'` for cheap deterministic
 * checks, or `kind: 'llm'` if the user wants a real-judge signal.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { loadBenchmark } from './benchmark.ts';
import { D_SEL_MIN_SIZE } from './types.ts';
import type { BenchmarkTask } from './types.ts';
import { scoreSkillOnTasks } from './validate-gate.ts';

const CAPTURE_CONFIG_KEY = 'skillopt.capture_enabled';

/**
 * Minimum held-out task count required to gate a BUNDLED-skill mutation. A
 * too-small (or empty) held-out set passes the gate vacuously, which would
 * re-open the benchmark-gaming hole the gate exists to close. Derived from the
 * D_sel floor so the two can't silently desync (the comment used to claim a
 * mirror that the code didn't enforce).
 */
export const MIN_HELD_OUT_SIZE = D_SEL_MIN_SIZE;

export function capturesDir(): string {
  const home = process.env.GBRAIN_HOME ?? process.env.HOME ?? '';
  return path.join(home, '.gbrain', 'skillopt-captures');
}

export function capturePath(skillName: string, runId: string): string {
  return path.join(capturesDir(), skillName, `${runId}.jsonl`);
}

/** Read the opt-in flag. Default false. */
export async function isCaptureEnabled(engine: BrainEngine): Promise<boolean> {
  try {
    const v = await engine.getConfig(CAPTURE_CONFIG_KEY);
    return v === 'true';
  } catch {
    return false;
  }
}

export interface CapturedRollout {
  ts: string;
  skill_name: string;
  task: string;
  final_text: string;
  tool_calls: Array<{ name: string; failed?: boolean }>;
  /** Optional user-supplied label for whether this rollout was "good". */
  label?: 'good' | 'bad' | null;
}

/**
 * Append one captured rollout to the per-skill JSONL. Best-effort —
 * stderr-warns on write failure, never throws.
 */
export function appendCapture(skillName: string, runId: string, row: CapturedRollout): void {
  const file = capturePath(skillName, runId);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(row) + '\n', 'utf8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[skillopt-capture] write failed for ${skillName} (${msg}); capture skipped\n`);
  }
}

/**
 * Load a held-out JSONL file. Same shape as benchmark; reuses loadBenchmark
 * for validation + parsing.
 */
export function loadHeldOut(heldOutPath: string): BenchmarkTask[] {
  if (!fs.existsSync(heldOutPath)) {
    throw new Error(`Held-out file does not exist: ${heldOutPath}`);
  }
  // Reuse the benchmark loader; it enforces the same shape contract.
  // bootstrapReviewed:true bypasses the sentinel check (held-out files
  // are user-curated, not LLM-bootstrapped).
  const bench = loadBenchmark(heldOutPath, { bootstrapReviewed: true });
  return bench.tasks;
}

export interface HeldOutGateOpts {
  engine: BrainEngine;
  candidateSkillText: string;
  baselineSkillText: string;
  heldOutTasks: BenchmarkTask[];
  targetModel: string;
  judgeModel: string;
  abortSignal?: AbortSignal;
}

export interface HeldOutGateResult {
  baselineScore: number;
  candidateScore: number;
  /** Candidate passes when score >= baseline (no margin — held-out is the safety net, not the discriminator). */
  passed: boolean;
}

/**
 * Run the held-out gate. The candidate is accepted only if its held-out
 * score is >= the baseline's held-out score. No epsilon margin (the D_sel
 * gate already filtered for noise; held-out is an independent confirmation,
 * not a second discriminator).
 */
export async function runHeldOutGate(opts: HeldOutGateOpts): Promise<HeldOutGateResult> {
  if (opts.heldOutTasks.length === 0) {
    // No held-out data: pass vacuously, log a stderr warn.
    process.stderr.write(`[skillopt-heldout] held-out task set is empty; gate passes vacuously\n`);
    return { baselineScore: 0, candidateScore: 0, passed: true };
  }

  const scoreOpts = {
    engine: opts.engine,
    tasks: opts.heldOutTasks,
    targetModel: opts.targetModel,
    judgeModel: opts.judgeModel,
    ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
  };
  const baselineScore = await scoreSkillOnTasks({ ...scoreOpts, skillText: opts.baselineSkillText });
  const candidateScore = await scoreSkillOnTasks({ ...scoreOpts, skillText: opts.candidateSkillText });

  return {
    baselineScore,
    candidateScore,
    passed: candidateScore >= baselineScore,
  };
}
