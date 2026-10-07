// src/core/remediation/types.ts
// v0.41.18.0 (A1, codex finding #2). Extracted from src/commands/doctor.ts
// so onboard CLI shell + MCP run_onboard op can compose against a stable
// library shape — NOT a CLI-shaped function with process.exit calls.
//
// Three consumers wrap this library today:
//   - src/commands/doctor.ts (runRemediationPlan + runRemediate)
//   - src/commands/onboard.ts (gbrain onboard --check / --auto)
//   - src/core/operations.ts (MCP op run_onboard, admin scope)

import type { RemediationStep } from '../remediation-step.ts';
import type { RepairPlanStep, RepairPreviewFailure, RepairStepResult } from './repairs.ts';
import type { ExplicitRepairNotice, RepairKindSpec } from '../repair/registry.ts';
import type { CapSource } from '../consent.ts';

/**
 * Options for computeRemediationPlan. All fields are optional with
 * sensible defaults.
 */
export interface RemediationPlanOpts {
  /** Target brain_score (default: 90). Used to drive recommendation count. */
  targetScore?: number;
  /**
   * v0.41.18.0 (A2 + codex #3): caller-supplied RemediationStep entries
   * threaded into the planner via the third arg of computeRecommendations.
   * Onboard wires the 4 new check helpers (embed_staleness,
   * entity_link_coverage, timeline_coverage, takes_count) here. doctor's
   * existing --remediation-plan call passes empty (preserving legacy
   * behavior).
   */
  extraRemediations?: RemediationStep[];
  /**
   * Doctor CLI only: preview every registered `gbrain repair` kind and list
   * the ones with pending items as PROTECTED repair steps, independent of the
   * score target. Omitted by onboard and MCP callers.
   */
  repairs?: { noEmbed?: boolean };
}

/**
 * Read-only plan output. Stable JSON envelope — downstream agents
 * (gbrain onboard, MCP run_onboard) bind to this shape.
 */
export interface RemediationPlan {
  schema_version: 2;
  brain_score_current: number;
  brain_score_target: number;
  max_reachable_score: number;
  target_unreachable: boolean;
  plan: Array<RemediationStep & { step: number }>;
  est_total_seconds: number;
  est_total_usd_cost: number;
  blocked: Array<{ check: string; reason: string }>;
  /** Present when `repairs` was requested: PROTECTED steps that need `--include-repairs`. */
  repair_steps?: RepairPlanStep[];
  /** Present with `repair_steps`: explicit-only kinds, never planned as steps; preview each by name. */
  explicit_repairs?: ExplicitRepairNotice[];
  /** Only when an automatic kind's preview threw: that kind is missing from `repair_steps`. */
  repair_preview_failures?: RepairPreviewFailure[];
}

/**
 * Options for runRemediation. The remediate orchestrator wraps the plan
 * loop with BudgetTracker, checkpoint resume, dep-cascade, and per-step
 * recheck. Hooks let callers (CLI / JSON / MCP) emit progress without
 * the library calling console directly.
 */
export interface RemediationOpts {
  /** Target brain_score (default: 90). */
  targetScore?: number;
  /**
   * Run each submitted job step in this process when no registered worker
   * serves the queue (PGLite always lacks one), as `jobs submit --follow`
   * does, instead of waiting out the step timeout. Set by the CLI entry point.
   */
  inlineJobs?: boolean;
  /** Cap inner loop iterations (default: Infinity). */
  maxJobs?: number;
  /** USD cap for total plan cost. Pre-flight refuse + mid-run BudgetExhausted gate. */
  maxUsd?: number;
  /** A4: where `maxUsd` came from (default `user`); a `derived` cap warns-and-runs an unpriced model and logs its exhaustion. */
  capSource?: CapSource;
  /** Read-only dry-run; submits no jobs; returns plan in result. */
  dryRun?: boolean;
  /** Resume from checkpoint matching this plan_hash, OR newest if undefined+resume=true. */
  resumePlanHash?: string;
  /** Whether to attempt resume at all (default false). */
  resume?: boolean;
  /**
   * Caller-supplied RemediationStep entries threaded into the planner.
   * Mirrors RemediationPlanOpts.extraRemediations so onboard's --apply
   * --auto path (and MCP run_onboard auto modes) forward the same
   * onboard-check remediations the --check path already passes through
   * computeRemediationPlan. Without this the runner saw only generic
   * brain_score remediations and reported "Nothing to do" whenever the
   * only applicable work was an extra (e.g. extract-ner).
   */
  extraRemediations?: RemediationStep[];
  /**
   * Doctor CLI only. Plans the registered repair kinds as PROTECTED steps and
   * runs them when `include` is true (the user's `--include-repairs`
   * agreement) and the caller is trusted local (`remote === false`). A
   * remote caller asking to include repairs is refused. `registry` replaces
   * the registered repair kinds (tests register stub specs).
   */
  repairs?: { include: boolean; remote: boolean; noEmbed?: boolean; registry?: readonly RepairKindSpec[] };
}

/**
 * Result of one step. status mirrors Minion job terminal states + a few
 * synthetic ones ('skipped_dep_aborted', 'skipped_completed_in_checkpoint').
 */
export interface StepResult {
  step: number;
  id: string;
  job_id: number | null;
  status: string;
  /** True when the submit deduped onto an existing IN-FLIGHT (waiting/active)
   *  row — job_id is that row; no new work was inserted (#3626). */
  coalesced?: boolean;
  /** #3626: set when a prior run's terminal (completed/failed) row still held
   *  the content-hash key. Carries that stale row's id; the step re-ran for
   *  real under a `:r:<doctor_run_id>`-rotated key (job_id is the fresh job). */
  deduped_job_id?: number;
}

/**
 * Result of a full runRemediation invocation. Stable shape for JSON
 * emission and MCP envelope.
 */
export interface RemediationResult {
  doctor_run_id: string;
  brain_score_initial: number;
  brain_score_final: number;
  brain_score_target: number;
  target_reached: boolean;
  submitted: StepResult[];
  aborted_count: number;
  /** Set when the run aborted on BudgetExhausted. Caller decides exit code. */
  budget_exhausted?: {
    spent: number;
    cap: number;
    reason: string;
    model_id?: string;
    plan_hash: string;
  };
  /** Set when the pre-flight ceiling check refused the target. */
  target_unreachable?: {
    target: number;
    ceiling: number;
  };
  /**
   * Set when the score target is unreachable: the paid job steps (`skipped`
   * ids) were not run; free job steps and included repair steps still ran.
   */
  job_steps_skipped?: { reason: 'target_unreachable'; target: number; ceiling: number; skipped?: string[] };
  /** Set when `--resume` refused (a checkpoint for another brain). */
  resume_refused?: { reason: string; checkpoint_brain_id: string; brain_id: string; plan_hash: string };
  /** Repair steps the run applied or refused (only when `repairs` was passed). */
  repairs?: RepairStepResult[];
  /** Repair steps planned but not run because the user's agreement was missing. */
  repairs_skipped?: RepairPlanStep[];
  /** Only when an automatic kind's preview threw: this run neither planned nor applied that kind. */
  repair_preview_failures?: RepairPreviewFailure[];
  /** Cumulative cap and settled spend across the original run and its resumes. */
  budget?: { max_usd: number | null; spent_usd: number; include_repairs: boolean; plan_hash: string };
}

/**
 * Hooks let the caller observe + report progress without the library
 * emitting to stdout/stderr itself. Every hook is optional.
 */
export interface RemediationHooks {
  /** Fired once when the orchestrator decides nothing needs to run. */
  onNothingToDo?: (initialScore: number, target: number) => void;
  /** Fired when the pre-flight ceiling check refuses the target. */
  onTargetUnreachable?: (target: number, ceiling: number) => void;
  /** Fired when --max-usd refuses the plan. */
  onBudgetRefused?: (estCost: number, cap: number) => void;
  /** Fired before each step submission. */
  onStepStart?: (step: number, total: number, rec: RemediationStep) => void;
  /** Fired after each step reaches a terminal state (or skip). */
  onStepEnd?: (result: StepResult) => void;
  /** Fired on BudgetExhausted thrown mid-loop. */
  onBudgetExhausted?: (planHash: string, snapshot: NonNullable<RemediationResult['budget_exhausted']>) => void;
  /** Fired on resume-checkpoint load (resume mode only). */
  onResumeLoaded?: (planHash: string, completedCount: number, remainingCount: number) => void;
  /** Fired on resume-checkpoint miss (resume mode only). */
  onResumeMissed?: (planHash: string, requested?: string) => void;
  /** Fired when the resume checkpoint belongs to another brain. */
  onResumeBrainMismatch?: (planHash: string, checkpointBrain: string, brain: string) => void;
  /** Fired with the cap a resume reuses from its checkpoint. */
  onResumeCap?: (cap: number | null, spent: number) => void;
  /** Fired before and after each repair step. */
  onRepairStepStart?: (step: RepairPlanStep) => void;
  onRepairStepEnd?: (step: RepairPlanStep, result: RepairStepResult) => void;
}
