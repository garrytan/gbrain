/**
 * v0.41.16.0 — Progressive-batch primitive type surface.
 *
 * Shared types for `runProgressiveBatch` and its consumers. Lives in its
 * own file so type-only imports don't drag the orchestrator's runtime
 * dependencies (AsyncLocalStorage, audit-writer) into pure callers.
 *
 * Design constraints (eng review D2, D3, D4, D20, D21):
 *
 *   - D2: extracted as a first-class primitive after rule-of-three
 *     satisfied across 12+ ad-hoc batch sites in gbrain.
 *
 *   - D3: budget gate is fail-CLOSED. Primitive reads
 *     `getCurrentBudgetTracker()` from `src/core/ai/gateway.ts` ahead
 *     of `Policy.maxCostUsd`. When BOTH are null, the primitive
 *     aborts with `reason: 'no_budget_safety_net'` rather than
 *     silently running unbounded.
 *
 *   - D4: primitive uses `Stage` (corpus-rollout axis). Parser uses
 *     `ParsePhase` (per-page axis). Different audit JSONLs. Do NOT
 *     conflate; they're orthogonal.
 *
 *   - D20: Verifier is a discriminated union. Output-count verifiers
 *     (parser, contradiction-eval) AND idempotent-mutation verifiers
 *     (reindex, embed) AND noop verifiers (sites that want only ramp
 *     + cost gating) all fit cleanly. No round-peg-square-hole.
 *
 *   - D21: Sites without an existing ramp keep jump-to-full as
 *     default. Ramp is opt-in per-site via `Policy.interactiveAbortMs
 *     > 0`. Honest behavior preservation.
 */

/**
 * The fixed stages of a progressive-batch run. The actual item counts
 * per stage are configured via `Policy.stages` (default: [10, 100, 500]
 * with `full` implicit).
 *
 * `trial` runs first against the smallest slice. `ramp_100` and
 * `ramp_500` are intermediate gates. `full` processes whatever items
 * remain after the earlier stages.
 */
export type Stage = 'trial' | 'ramp_100' | 'ramp_500' | 'full';

/**
 * Verdict from a verifier or from the orchestrator's own gating.
 * Exhaustive TypeScript union — every consumer site should `switch`
 * with a `never` default to catch future additions at compile time.
 */
export type StageVerdict =
  | 'proceed'              // All checks passed; advance to next stage
  | 'abort_data_quality'   // sampleQuality returned ok=false
  | 'abort_count_mismatch' // OutputCountVerifier: actualDelta outside expected band
  | 'abort_mutation_mismatch' // IdempotentMutationVerifier: rows-modified count off
  | 'abort_error_rate'     // observed error rate > Policy.maxErrorRate
  | 'abort_cost_cap'       // projected full-batch cost > effective cap
  | 'abort_user'           // Ctrl-C during interactive grace window
  | 'abort_explicit';      // caller's onStageReport returned {abort: true}

/**
 * Reason code attached to abort verdicts. Surfaces in audit JSONL and
 * stderr reports. The two budget reasons (`cost_projected_over_cap`
 * and `no_budget_safety_net`) are the load-bearing ones for the D3
 * fail-closed contract.
 */
export type AbortReason =
  | 'data_quality_sample_failed'
  | 'count_delta_outside_band'
  | 'mutation_count_outside_band'
  | 'error_rate_exceeded'
  | 'cost_projected_over_cap'
  | 'no_budget_safety_net'  // D3: neither tracker nor Policy.maxCostUsd set
  | 'user_aborted'
  | 'caller_signaled_abort';

/**
 * Quality verdict returned by `sampleQuality()`. Free-form `reasons`
 * surface in the audit JSONL when `ok: false`.
 */
export interface QualityVerdict {
  ok: boolean;
  reasons?: string[];
}

/**
 * Verifier shape #1 — caller's batch produces NEW rows (parser,
 * contradiction-eval, atom extraction, etc.). The verifier knows how
 * many rows SHOULD appear after processing N items and where to count
 * them.
 *
 * Used by retrofit sites where row-count is the natural success
 * signal.
 */
export interface OutputCountVerifier {
  kind: 'output_count';
  /** Pre-stage row count. */
  countBefore(): Promise<number>;
  /** Post-stage row count. */
  countAfter(): Promise<number>;
  /**
   * How many rows SHOULD appear after processing `processed` items.
   * Returning `null` skips count-mismatch gating for this stage
   * (caller has stage-specific reasons; e.g. dry-run inserts).
   */
  expectedDelta(processed: number): number | null;
  /** Sample ≤3 random output rows, return ok/not-ok + reasons. */
  sampleQuality(): Promise<QualityVerdict>;
  /** Cost projection per item at the given stage. */
  costPerItem(stage: Stage): number;
}

/**
 * Verifier shape #2 — caller's batch UPDATES existing rows in-place
 * (reindex, embed, content-hash refresh). Row-count delta is always
 * zero; what matters is rows-mutated.
 *
 * D20: codex outside-voice correctly flagged that
 * `expectedDelta(processed)` doesn't fit reindex semantics. This
 * verifier shape closes that gap.
 */
export interface IdempotentMutationVerifier {
  kind: 'idempotent_mutation';
  /**
   * Count rows-mutated by the stage's batch. Caller defines what
   * "mutated" means (chunker_version bump, embedding_at refresh,
   * etc.). Default expectation: equals processed-item count.
   */
  mutatedCount(): Promise<number>;
  /**
   * How many mutations SHOULD have happened after processing
   * `processed` items. Defaults to `processed` (1:1) if not
   * overridden. Returning `null` skips mutation-count gating.
   */
  expectedMutations?(processed: number): number | null;
  /** Sample ≤3 random mutated rows, return ok/not-ok + reasons. */
  sampleQuality(): Promise<QualityVerdict>;
  /** Cost projection per item at the given stage. */
  costPerItem(stage: Stage): number;
}

/**
 * Verifier shape #3 — caller wants ramp + cost gating but NO output
 * verification. Common for sites that previously "jumped straight to
 * full" (per D21) where adding count verification would be a behavior
 * change beyond what the retrofit promised.
 *
 * Still requires `costPerItem` so the cost cap can be projected
 * honestly.
 */
export interface NoopVerifier {
  kind: 'noop';
  /** Cost projection per item at the given stage. */
  costPerItem(stage: Stage): number;
  /**
   * Optional quality probe. When omitted, sampleQuality is treated as
   * `{ok: true}` at every stage. Useful for ramp+cost-only callers
   * that still want a structural smoke check.
   */
  sampleQuality?(): Promise<QualityVerdict>;
}

/** Discriminated union of all three verifier shapes. */
export type Verifier =
  | OutputCountVerifier
  | IdempotentMutationVerifier
  | NoopVerifier;

/**
 * Per-stage report passed to the caller's optional `onStageReport`
 * callback (and emitted to stderr by the default reporter). Stable
 * shape: callers can persist these in their own audit trails without
 * re-deriving from the primitive's JSONL.
 */
export interface StageReport {
  operationId: string;
  label: string;
  stage: Stage;
  itemsInStage: number;
  itemsProcessedCumulative: number;
  totalItems: number;
  verdict: StageVerdict;
  abortReason?: AbortReason;
  errorRate: number;
  costEstimateRunningUsd: number;
  costProjectedFullUsd: number;
  /** Verifier-specific deltas (count, mutation, etc.). */
  deltaObserved?: number;
  deltaExpected?: number | null;
  /** Wall-clock for this stage's processing. */
  stageMs: number;
  /** Per-stage quality verdict reasons (when sampleQuality returned not-ok). */
  qualityReasons?: string[];
}

/**
 * Caller's response to onStageReport. Returning `{abort: true}` halts
 * the run with verdict `abort_explicit`. Returning anything else
 * (including undefined) is implicit "proceed".
 */
export interface StageReportResponse {
  abort?: boolean;
  /** Operator override on the stage list for the next stage (rare). */
  rewriteRemainingStages?: number[];
}

/**
 * Per-batch policy. Mostly defaults; callers override per-site.
 */
export interface Policy {
  /** Max observed error rate before abort. Default: 0.02 (2%). */
  maxErrorRate?: number;
  /**
   * Effective USD cap. When set, the primitive applies it as the
   * upper bound regardless of any active BudgetTracker (the lower of
   * the two wins — caller can never EXCEED the tracker's cap, but
   * can voluntarily cap themselves tighter).
   *
   * When unset AND no active BudgetTracker, the primitive ABORTS at
   * stage 0 with `abort_cost_cap reason='no_budget_safety_net'`
   * (D3 fail-closed). Caller must explicitly opt out of safety with
   * `requireBudgetSafetyNet: false`.
   */
  maxCostUsd?: number;
  /**
   * Caller opt-out of the D3 safety net. Sites that legitimately
   * don't need cost gating (cheap deterministic ops) set this true.
   * Documented in the retrofit's commit message + tests.
   * Default: false (safety net required).
   */
  requireBudgetSafetyNet?: boolean;
  /**
   * Interactive Ctrl-C grace window per stage transition, in ms.
   * 0 (default) means no grace window (CI / non-TTY / Minion workers).
   * Honored only when TTY is detected; non-TTY callers always skip.
   *
   * D21: sites that previously "jumped straight to full" keep
   * `interactiveAbortMs: 0` so behavior parity holds; the ramp itself
   * is opt-IN per-site via this flag.
   */
  interactiveAbortMs?: number;
  /**
   * Stage item counts. Default: [10, 100, 500] with `full` implicit.
   * Override via `GBRAIN_PROGRESSIVE_BATCH_STAGES=10,100,500` env or
   * per-call. Empty array = skip ramp, go straight to `full`.
   */
  stages?: number[];
  /**
   * Per-stage reporter. Default: writes ASCII stage line to stderr.
   * Returns optional response to influence the orchestrator.
   */
  onStageReport?(report: StageReport): Promise<StageReportResponse | void> | StageReportResponse | void;
  /** Phase/label for audit + telemetry. */
  label: string;
  /**
   * Caller-supplied operation id for tracing across stages. Defaults
   * to a generated short id at orchestrator entry.
   */
  operationId?: string;
}

/** Final result of a complete `runProgressiveBatch` invocation. */
export interface ProgressiveBatchResult {
  operationId: string;
  label: string;
  totalItems: number;
  itemsProcessed: number;
  stagesCompleted: Stage[];
  abortedAt?: { stage: Stage; verdict: StageVerdict; reason?: AbortReason };
  totalCostUsd: number;
  durationMs: number;
  /** All per-stage reports in order. */
  stageReports: StageReport[];
}

/**
 * The per-stage callback the caller provides. Receives the slice for
 * THIS stage; returns the number of items successfully processed
 * (used for error-rate calculation) AND a per-stage cost actual
 * (used for cumulative-cost tracking).
 *
 * Callers process the slice however they like (serial, batched,
 * concurrent). The primitive doesn't dictate; it only sequences
 * stages and gates between them.
 */
export type StageRunner<T> = (
  items: T[],
  stage: Stage,
  operationId: string,
) => Promise<{ succeeded: number; failed: number; costUsd: number }>;
