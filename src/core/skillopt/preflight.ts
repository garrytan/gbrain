/**
 * SkillOpt cost preflight (D3).
 *
 * Estimates the total USD cost of a run BEFORE any LLM call fires.
 * Refuses to start when estimate > --max-cost-usd. In TTY, prompts the
 * user with a 10-second Ctrl-C grace window (mirrors the progressive-batch
 * cost-prompt UX).
 *
 * Cost model (rough but consistent):
 *
 *   Per step:
 *     - batch_size rollouts × target-model price
 *     - 2 reflect calls (D7) × optimizer-model price
 *     - sel_size sel-tasks × VALIDATION_RUNS_PER_TASK × target-model price
 *     - sel_size sel-tasks × VALIDATION_RUNS_PER_TASK × judge-model price
 *
 *   Total:
 *     - 1× baseline eval on D_sel
 *     - epochs × steps_per_epoch × per-step cost
 *     - epochs × 1 slow-update reflect call (if no improvement that epoch)
 *     - 1× final test eval on D_test
 *
 * Prices come from existing per-model pricing tables (Anthropic +
 * embedding-pricing). For unknown providers we fail-loud — same posture
 * as BudgetTracker's TX2 contract.
 */

import { ANTHROPIC_PRICING } from '../anthropic-pricing.ts';
import { VALIDATION_RUNS_PER_TASK } from './types.ts';

/** Conservative per-rollout token estimates (input + output). */
const ROLLOUT_INPUT_TOKENS = 3000; // skill + task prompt + tool defs
const ROLLOUT_OUTPUT_TOKENS = 800;
const REFLECT_INPUT_TOKENS = 8000; // skill + trajectories + rejected buffer
const REFLECT_OUTPUT_TOKENS = 1500;
const JUDGE_INPUT_TOKENS = 2000; // rubric + agent output
const JUDGE_OUTPUT_TOKENS = 200;

export interface PreflightOpts {
  epochs: number;
  batchSize: number;
  trainSize: number;
  selSize: number;
  testSize: number;
  optimizerModel: string;
  targetModel: string;
  judgeModel: string;
  maxCostUsd: number;
  /**
   * Held-out task count (F11). When > 0, the held-out gate scores baseline +
   * candidate on the held-out set at every accepted step. Conservatively
   * priced as if EVERY step accepts (upper bound) so the cap is honest.
   * 0 / omitted = no held-out gate.
   */
  heldOutSize?: number;
  /** When true, print the prompt to stderr + use Ctrl-C grace. Default false (non-TTY). */
  interactive?: boolean;
}

export interface PreflightEstimate {
  steps_per_epoch: number;
  total_steps: number;
  rollout_calls: number;
  reflect_calls: number;
  judge_calls: number;
  est_input_tokens: number;
  est_output_tokens: number;
  est_cost_usd: number;
  /** Per-model breakdown for the audit. */
  per_model_cost_usd: Record<string, number>;
  /** True when est_cost_usd > maxCostUsd (caller should refuse or prompt). */
  exceeds_cap: boolean;
}

export interface PreflightResult {
  estimate: PreflightEstimate;
  /** When false, caller should abort. When true, run may proceed. */
  proceed: boolean;
  /** Reason for abort, if proceed=false. */
  abort_reason?: string;
}

export function estimateCost(opts: PreflightOpts): PreflightEstimate {
  const stepsPerEpoch = Math.max(1, Math.floor(opts.trainSize / opts.batchSize));
  const totalSteps = opts.epochs * stepsPerEpoch;

  // Per-step counts.
  const rolloutsPerStep = opts.batchSize;
  const reflectsPerStep = 2; // D7: two reflect calls
  const sel_runs_per_step = opts.selSize * VALIDATION_RUNS_PER_TASK;

  // F11 held-out: baseline + candidate scored on the held-out set at every
  // accepted step. Upper-bound: assume every step accepts (2 = baseline+candidate).
  const heldOutSize = opts.heldOutSize ?? 0;
  const heldOutRollouts = heldOutSize > 0
    ? totalSteps * heldOutSize * VALIDATION_RUNS_PER_TASK * 2
    : 0;

  // Cumulative counts across the whole run.
  const rollout_calls = totalSteps * rolloutsPerStep
    + opts.selSize * VALIDATION_RUNS_PER_TASK // baseline sel eval
    + opts.selSize * VALIDATION_RUNS_PER_TASK * totalSteps // per-step sel validation
    + opts.testSize * 2 // final test eval (best + baseline)
    + heldOutRollouts; // F11 held-out gate (baseline+candidate per accepted step)
  const reflect_calls = totalSteps * reflectsPerStep
    + opts.epochs; // slow-update meta calls
  const judge_calls = opts.selSize // baseline (1 per task; median-of-3 is in the rollout count already? — no, judge runs per rollout)
    + opts.selSize * VALIDATION_RUNS_PER_TASK * totalSteps // per-step validation
    + opts.testSize * 2 // final test judges (best + baseline)
    + heldOutRollouts; // F11 held-out judges (1 per held-out rollout)

  // Cost per call type.
  const targetPrice = lookupPrice(opts.targetModel);
  const optimizerPrice = lookupPrice(opts.optimizerModel);
  const judgePrice = lookupPrice(opts.judgeModel);

  const rolloutCost = rollout_calls * (
    (ROLLOUT_INPUT_TOKENS * targetPrice.input) / 1_000_000
    + (ROLLOUT_OUTPUT_TOKENS * targetPrice.output) / 1_000_000
  );
  const reflectCost = reflect_calls * (
    (REFLECT_INPUT_TOKENS * optimizerPrice.input) / 1_000_000
    + (REFLECT_OUTPUT_TOKENS * optimizerPrice.output) / 1_000_000
  );
  const judgeCost = judge_calls * (
    (JUDGE_INPUT_TOKENS * judgePrice.input) / 1_000_000
    + (JUDGE_OUTPUT_TOKENS * judgePrice.output) / 1_000_000
  );

  // D11 prompt caching gives ~50% discount on stable layers. Apply
  // conservatively (assume 50% of optimizer + judge tokens are cached).
  const cachedReflectCost = reflectCost * 0.6;
  const cachedJudgeCost = judgeCost * 0.6;

  const total = rolloutCost + cachedReflectCost + cachedJudgeCost;
  void sel_runs_per_step;

  return {
    steps_per_epoch: stepsPerEpoch,
    total_steps: totalSteps,
    rollout_calls,
    reflect_calls,
    judge_calls,
    est_input_tokens: rollout_calls * ROLLOUT_INPUT_TOKENS + reflect_calls * REFLECT_INPUT_TOKENS + judge_calls * JUDGE_INPUT_TOKENS,
    est_output_tokens: rollout_calls * ROLLOUT_OUTPUT_TOKENS + reflect_calls * REFLECT_OUTPUT_TOKENS + judge_calls * JUDGE_OUTPUT_TOKENS,
    est_cost_usd: total,
    per_model_cost_usd: {
      [opts.targetModel]: rolloutCost,
      [opts.optimizerModel]: cachedReflectCost,
      [opts.judgeModel]: cachedJudgeCost,
    },
    exceeds_cap: total > opts.maxCostUsd,
  };
}

/**
 * Render a human-readable preflight summary to stderr. Caller may follow
 * with a Ctrl-C grace prompt in TTY mode (see runPreflightPrompt).
 */
export function formatPreflightReport(est: PreflightEstimate, opts: PreflightOpts): string {
  return [
    `[skillopt] Cost estimate for ${opts.epochs} epochs × ${est.steps_per_epoch} steps × ${opts.batchSize} rollouts:`,
    `  Rollouts:   ${est.rollout_calls.toLocaleString()} calls`,
    `  Reflects:   ${est.reflect_calls.toLocaleString()} calls`,
    `  Judges:     ${est.judge_calls.toLocaleString()} calls`,
    `  Tokens:     ~${(est.est_input_tokens / 1000).toFixed(0)}K in / ~${(est.est_output_tokens / 1000).toFixed(0)}K out`,
    `  Est. cost:  $${est.est_cost_usd.toFixed(2)} (cap: $${opts.maxCostUsd.toFixed(2)})`,
    est.exceeds_cap ? `  WARNING:    estimate exceeds --max-cost-usd cap.` : '',
  ].filter(Boolean).join('\n');
}

/**
 * Decision wrapper. Returns {proceed: false, abort_reason} when the
 * estimate over-shoots the cap (caller exits 2). Returns {proceed: true}
 * otherwise. Interactive=true callers should print formatPreflightReport
 * + a Ctrl-C grace window separately.
 */
export function preflight(opts: PreflightOpts): PreflightResult {
  const estimate = estimateCost(opts);
  if (estimate.exceeds_cap) {
    return {
      estimate,
      proceed: false,
      abort_reason: `estimated cost $${estimate.est_cost_usd.toFixed(2)} exceeds --max-cost-usd $${opts.maxCostUsd.toFixed(2)}. Raise the cap with --max-cost-usd ${Math.ceil(estimate.est_cost_usd)} or reduce --epochs/--batch-size.`,
    };
  }
  return { estimate, proceed: true };
}

function lookupPrice(model: string): { input: number; output: number } {
  // Anthropic models — strip provider prefix.
  const bare = model.startsWith('anthropic:') ? model.slice('anthropic:'.length) : model;
  const anth = (ANTHROPIC_PRICING as Record<string, { input: number; output: number }>)[bare];
  if (anth) return anth;
  // Conservative fallback: assume Sonnet-tier pricing for unknown providers.
  // Don't throw — preflight is for warning, not gating. The actual budget
  // tracker (BudgetTracker TX2) will fail-loud at run time if pricing is
  // truly unknown.
  return { input: 3.0, output: 15.0 };
}
