/**
 * SkillOpt v1 types — single source of truth for the optimization loop.
 *
 * The optimizer treats SKILL.md as the trainable parameters of a frozen
 * agent. See plan: ~/.claude/plans/system-instruction-you-are-working-drifting-falcon.md.
 *
 * Per the v0.41.20.0 plan decisions:
 *  D2: rollout uses gateway.toolLoop (no DB pollution).
 *  D5: frontmatter mutation is forbidden; edits operate on body slice only.
 *  D9: applyEdit returns a tagged result, not throws.
 *  D12: validation gate uses median-of-3 + epsilon=0.05.
 *  D17: D_sel >= 5 floor enforced at benchmark-load time.
 */

import type { BrainEngine } from '../engine.ts';

// ─── Benchmarks + judges ──────────────────────────────────────────────────

/** Rule-check kinds for `judge: rule`. Each is deterministic and free. */
export type RuleCheckOp =
  | 'contains'
  | 'regex'
  | 'section_present'
  | 'max_chars'
  | 'min_citations'
  | 'tool_called'
  | 'tool_not_called';

export interface RuleCheck {
  op: RuleCheckOp;
  arg: string | number;
}

export type JudgeKind = 'rule' | 'llm' | 'qrels';

export type Judge =
  | { kind: 'rule'; checks: RuleCheck[] }
  | { kind: 'llm'; rubric: string; model?: string }
  | { kind: 'qrels'; expected_slugs: string[]; k: number };

export interface BenchmarkTask {
  task_id: string;
  task: string;
  judge: Judge;
}

export interface Benchmark {
  /** Path the benchmark was loaded from (for error messages). */
  source_path: string;
  tasks: BenchmarkTask[];
  /** SHA-256 of the canonical JSON, truncated to 16 hex. Stable across reorderings. */
  benchmark_sha8: string;
}

/** D17: enforced floor for D_sel. */
export const D_SEL_MIN_SIZE = 5;

export interface BenchmarkSplit {
  train: BenchmarkTask[];
  sel: BenchmarkTask[];
  test: BenchmarkTask[];
}

// ─── Edit ops ─────────────────────────────────────────────────────────────

/** D9: applyEdit returns a tagged result, not throws. */
export type EditOp =
  | { op: 'add'; anchor: string; content: string; reason?: string }
  | { op: 'replace'; target: string; replacement: string; reason?: string }
  | { op: 'delete'; target: string; reason?: string };

export type EditRejectionReason =
  | 'anchor_not_found'
  | 'anchor_ambiguous'
  | 'target_not_found'
  | 'target_ambiguous'
  | 'inside_code_fence'
  | 'crosses_frontmatter'
  | 'working_tree_dirty'
  | 'install_path'
  | 'no_change';

export type EditResult =
  | { outcome: 'applied'; edit: EditOp; newText: string }
  | { outcome: 'rejected'; edit: EditOp; reason: EditRejectionReason; detail?: string };

// ─── Trajectories + rollouts ──────────────────────────────────────────────

/** What a rollout produced. Captured in-process; never persisted to DB (D2). */
export interface Trajectory {
  task_id: string;
  task: string;
  /** Final assistant text (typically the user-visible output). */
  final_text: string;
  /** Tool calls observed during the rollout, in order. */
  tool_calls: Array<{ name: string; input: unknown; output?: unknown; failed?: boolean }>;
  /** Token usage from gateway.toolLoop. */
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
  };
  /** Number of agent turns the loop took. */
  turns: number;
  /** End reason from gateway.toolLoop. */
  stop_reason: 'end' | 'max_turns' | 'refusal' | 'content_filter' | 'aborted' | 'unrecoverable';
  /** Wall-clock duration in ms. */
  duration_ms: number;
}

export interface ScoredRollout {
  trajectory: Trajectory;
  /** 0..1 score from the judge. */
  score: number;
  /** Optional per-task rationale (LLM judge only). */
  rationale?: string;
  /** If the judge itself errored (parse fail, timeout), this is set. */
  judge_error?: string;
}

// ─── Run state + receipts ─────────────────────────────────────────────────

export interface SkillOptOpts {
  /** Kebab-case skill name. Resolves to `skills/<name>/SKILL.md`. */
  skillName: string;
  /** Absolute path to the benchmark JSONL file. */
  benchmarkPath: string;
  /** Brain engine (required for D14 lock + read-only tool calls during rollouts). */
  engine: BrainEngine;
  /** Skills directory root (used for bundled-skill detection, install-path gate). */
  skillsDir: string;

  // Training knobs.
  epochs: number;
  batchSize: number;
  /** Max edits per step (the LR). */
  lr: number;
  lrSchedule: 'cosine' | 'linear' | 'constant';
  /** Split ratio as 3-tuple, e.g. [4, 1, 5] for 4:1:5. */
  split: [number, number, number];

  // Models.
  optimizerModel: string;
  targetModel: string;
  judgeModel: string;

  // Modes.
  mode: 'patch' | 'rewrite';
  dryRun: boolean;
  noMutate: boolean;
  allowMutateBundled: boolean;
  bootstrapReviewed: boolean;
  /** F10: enable write-capture mode for write-flavored skills. */
  writeCapture?: boolean;
  /** F11: optional held-out test set path (validates winner before mutate). */
  heldOutPath?: string;
  json: boolean;

  // Safety.
  maxCostUsd: number;
  maxRuntimeMin: number;
  force: boolean;
  resumeRunId?: string;
}

export interface StepRecord {
  epoch: number;
  step: number;
  sel_score_median: number;
  sel_score_runs: number[];
  accepted: boolean;
  edits_attempted: number;
  edits_applied: number;
  delta: number;
  reason?: string;
  cumulative_cost_usd: number;
  ts: string;
}

export interface RunReceipt {
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
  max_cost_usd: number;
  started_at: string;
  ended_at?: string;
  outcome?: 'accepted' | 'no_improvement' | 'aborted' | 'errored';
  baseline_sel_score?: number;
  best_sel_score?: number;
  baseline_test_score?: number;
  test_score?: number;
  final_cost_usd?: number;
  total_steps?: number;
  epochs_completed?: number;
}

export interface HistoryRow {
  /** D8: pending → committed two-phase commit. */
  status: 'pending' | 'committed';
  run_id: string;
  version_n: number;
  ts: string;
  edits: EditOp[];
  sel_score: number;
  delta: number;
}

// ─── Validation gate (D12) ────────────────────────────────────────────────

/** D12: epsilon margin floor for accepting a candidate. */
export const VALIDATION_EPSILON = 0.05;
/** D12: number of judge runs per sel-task for noise rejection. */
export const VALIDATION_RUNS_PER_TASK = 3;

export interface GateInput {
  candidateSkillText: string;
  selSet: BenchmarkTask[];
  /** Best score so far on D_sel (epsilon-margin compare against this). */
  bestScore: number;
}

export interface GateResult {
  accepted: boolean;
  /** Per-task median across N runs. */
  perTaskMedians: Array<{ task_id: string; median: number; runs: number[] }>;
  /** Mean of per-task medians. */
  selScore: number;
  reason?: 'no_margin' | 'below_baseline' | 'all_judge_errors';
  /**
   * Every scored rollout this gate produced, in selSet order (runs per task
   * flattened). Used by the orchestrator's forward pass to partition into
   * successes/failures for reflect. Sel-side gates also surface this but the
   * orchestrator only reads it for the forward path (runsPerTask=1).
   */
  scoredRollouts: ScoredRollout[];
}

// ─── Bootstrap sentinel (D15) ─────────────────────────────────────────────

/** D15: sentinel line written at the end of bootstrap-from-routing output. */
export const BOOTSTRAP_PENDING_REVIEW = '# BOOTSTRAP_PENDING_REVIEW';

// ─── Bundled-skill gate (D16) ─────────────────────────────────────────────

/**
 * D16: a skill is "bundled" when its SKILL.md lives under the repo's
 * canonical `skills/` directory (relative to the gbrain install root).
 * Bundled skills require `--allow-mutate-bundled` to overwrite.
 */
export interface BundledSkillContext {
  skillName: string;
  skillsDir: string;
  /** Resolved absolute path to skills/<name>/SKILL.md. */
  skillPath: string;
  /** True when the skillsDir is the repo's `skills/` (install path). */
  isBundled: boolean;
}
