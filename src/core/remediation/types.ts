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
  /** Cap inner loop iterations (default: Infinity). */
  maxJobs?: number;
  /** USD cap for total plan cost. Pre-flight refuse + mid-run BudgetExhausted gate. */
  maxUsd?: number;
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
   * Whether this caller is allowed to submit PROTECTED_JOB_NAMES steps.
   * Default false — the fail-closed posture.
   *
   * The runner computes its own base recommendations internally
   * (computeRecommendations), so a caller filtering its `extraRemediations`
   * does NOT filter the base plan. Before this flag existed that was
   * invisible, because no base recommendation named a protected job. Adding
   * 'sync' to PROTECTED_JOB_NAMES made it load-bearing: the `sync.repo`
   * recommendation is a base one, so without a trust signal the runner would
   * either hand a remote MCP `run_onboard` caller a protected submission, or
   * hard-throw on the CLI path. Neither is acceptable, so trust is now
   * explicit and travels from the entry point.
   *
   * Set true by the local CLI (`gbrain doctor --remediate`). Set from the
   * caller's `run_protected_onboard` scope by MCP run_onboard. When false,
   * protected steps are dropped from the plan and reported in
   * `skipped_protected` rather than attempted.
   */
  allowProtected?: boolean;
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
  /**
   * Steps dropped from the plan because they name a PROTECTED job and the
   * caller did not pass `allowProtected`. Present (possibly empty) on every
   * run so an untrusted caller can see WHY the plan did less than the
   * `check`-mode preview promised, instead of silently under-remediating.
   */
  skipped_protected?: Array<{ id: string; job: string; reason: string }>;
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
}
