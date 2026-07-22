/**
 * SkillOpt validation gate (D12 + D4).
 *
 * D12 — median-of-3 judge runs per sel-task + epsilon=0.05 margin.
 * D4 — parallel sel-task scoring via runWithLimit cap=4.
 *
 * Pseudocode:
 *
 *   For each sel-task t in selSet:
 *     scores[t] = median(await Promise.all([
 *       scoreTrajectory(rollout(candidate, t), judge),  // run 1
 *       scoreTrajectory(rollout(candidate, t), judge),  // run 2
 *       scoreTrajectory(rollout(candidate, t), judge),  // run 3
 *     ]))
 *   sel_score = mean(scores)
 *   if sel_score > best_score + 0.05: ACCEPT
 *   else: REJECT
 *
 * The 3 rollout calls per sel-task share the same candidate-skill prompt
 * which is cached (D11), so the effective cost ~1.3x not 3x.
 */

import { runWithLimit, isMustAbortError } from '../worker-pool.ts';
import { runRollout, type RolloutOpts } from './rollout.ts';
import { scoreTrajectory } from './score.ts';
import type { BenchmarkTask, GateInput, GateResult, ScoredRollout } from './types.ts';
import { VALIDATION_EPSILON, VALIDATION_RUNS_PER_TASK } from './types.ts';
import type { BrainEngine } from '../engine.ts';

export interface ValidateGateOpts extends Omit<GateInput, 'selSet'> {
  selSet: BenchmarkTask[];
  engine: BrainEngine;
  targetModel: string;
  judgeModel?: string;
  /** D4: max in-flight sel-task evaluations. Default 4. */
  concurrency?: number;
  /**
   * Runs per task for the median-of-N. Default `VALIDATION_RUNS_PER_TASK` (3)
   * for sel-side acceptance gates. The orchestrator's forward pass passes 1
   * because we only need a rough partition into successes/failures, not noise
   * rejection. Must be >= 1.
   */
  runsPerTask?: number;
  abortSignal?: AbortSignal;
  /** Test seam — substitute rollout. */
  rolloutFn?: typeof runRollout;
  /** Test seam — substitute scoreTrajectory. */
  scoreFn?: typeof scoreTrajectory;
}

/**
 * Run the validation gate against a candidate skill. Returns GateResult
 * with accept/reject + per-task medians for the audit JSONL.
 */
export async function runValidationGate(opts: ValidateGateOpts): Promise<GateResult> {
  const rolloutFn = opts.rolloutFn ?? runRollout;
  const scoreFn = opts.scoreFn ?? scoreTrajectory;
  const concurrency = opts.concurrency ?? 4;
  // Forward pass uses 1; sel/baseline use VALIDATION_RUNS_PER_TASK (3). Floor
  // at 1 (a runsPerTask of 0 would silently produce an empty median).
  const runsPerTask = Math.max(1, opts.runsPerTask ?? VALIDATION_RUNS_PER_TASK);

  interface PerTask {
    task_id: string;
    median: number;
    runs: number[];
    rollouts: ScoredRollout[];
  }

  // Per sel-task, run N rollouts + N judges, take median.
  const settled = await runWithLimit({
    items: opts.selSet,
    limit: concurrency,
    fn: async (task: BenchmarkTask): Promise<PerTask> => {
      const runs: number[] = [];
      const rollouts: ScoredRollout[] = [];
      for (let i = 0; i < runsPerTask; i++) {
        const rolloutOpts: RolloutOpts = {
          engine: opts.engine,
          skillText: opts.candidateSkillText,
          task,
          targetModel: opts.targetModel,
          abortSignal: opts.abortSignal,
        };
        const trajectory = await rolloutFn(rolloutOpts);
        const scored: ScoredRollout = await scoreFn(trajectory, task.judge, {
          judgeModel: opts.judgeModel,
        });
        runs.push(scored.score);
        rollouts.push(scored);
      }
      return { task_id: task.task_id, median: median(runs), runs, rollouts };
    },
    signal: opts.abortSignal,
  });

  // MUST-ABORT errors (budget exhaustion / no-pricing) are NOT scoring noise —
  // swallowing them as score=0 turns a pricing/cap crash into a fake "0/N" run
  // (the bug the SkillOpt eval surfaced: a Haiku run with --max-cost hit
  // no_pricing on every rollout and the whole gate reported a vacuous 0). Surface
  // them loudly so the caller aborts instead of recording a hollow measurement.
  const aborter = settled.find((s) => s && !s.ok && isMustAbortError(s.error));
  if (aborter && !aborter.ok) throw aborter.error;

  // SettledItem<TOut>[] — extract successful results; treat (non-abort) errors as
  // score=0 (pessimistic fallback consistent with the judge fail-open posture).
  // Errored tasks contribute no scoredRollouts (caller's reflect sees fewer
  // trajectories rather than fabricated zero-score entries).
  const perTaskMedians = settled.map((s, idx) => {
    if (s && s.ok) return { task_id: s.value.task_id, median: s.value.median, runs: s.value.runs };
    return { task_id: opts.selSet[idx]!.task_id, median: 0, runs: [] };
  });
  const scoredRollouts: ScoredRollout[] = settled.flatMap((s) => (s && s.ok) ? s.value.rollouts : []);
  const selScore = perTaskMedians.length === 0
    ? 0
    : perTaskMedians.reduce((acc, r) => acc + r.median, 0) / perTaskMedians.length;

  // D12 accept rule: strict > best + epsilon. Ties/sub-epsilon-gains are
  // rejected (paper-faithful — protects against noise-as-improvement).
  const threshold = opts.bestScore + VALIDATION_EPSILON;
  const accepted = selScore > threshold;

  let reason: GateResult['reason'];
  if (!accepted) {
    if (selScore <= opts.bestScore) reason = 'below_baseline';
    else reason = 'no_margin';
  }
  return { accepted, perTaskMedians, selScore, scoredRollouts, ...(reason ? { reason } : {}) };
}

export interface ScoreOnTasksOpts {
  engine: BrainEngine;
  skillText: string;
  tasks: BenchmarkTask[];
  targetModel: string;
  judgeModel?: string;
  /** Median-of-N runs per task. Defaults to `VALIDATION_RUNS_PER_TASK` (3). */
  runsPerTask?: number;
  abortSignal?: AbortSignal;
  rolloutFn?: typeof runRollout;
  scoreFn?: typeof scoreTrajectory;
}

/**
 * Score a skill on an arbitrary task set and return the mean-of-per-task-medians
 * (`selScore`). The single primitive for "how good is this skill on these tasks?"
 * — used by the orchestrator's baseline + final-test eval, the held-out gate, and
 * the Track B eval harnesses, so they can't drift on scoring semantics. Thin
 * wrapper over `runValidationGate({ bestScore: -1 })` (any score "accepts"; we
 * only read `.selScore`).
 */
export async function scoreSkillOnTasks(opts: ScoreOnTasksOpts): Promise<number> {
  const gate = await runValidationGate({
    engine: opts.engine,
    candidateSkillText: opts.skillText,
    selSet: opts.tasks,
    bestScore: -1,
    targetModel: opts.targetModel,
    ...(opts.judgeModel !== undefined ? { judgeModel: opts.judgeModel } : {}),
    ...(opts.runsPerTask !== undefined ? { runsPerTask: opts.runsPerTask } : {}),
    ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
    ...(opts.rolloutFn ? { rolloutFn: opts.rolloutFn } : {}),
    ...(opts.scoreFn ? { scoreFn: opts.scoreFn } : {}),
  });
  return gate.selScore;
}

/** Pure median for an array of numbers. Returns 0 for empty array. */
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}
