/**
 * v0.41.16.0 — Progressive-batch primitive orchestrator.
 *
 * The single seam every batch-style gbrain operation routes through.
 * Replaces 12+ ad-hoc cost-prompt / TTY-grace / ramp-up patterns
 * scattered across reindex, reindex-multimodal, book-mirror,
 * brainstorm, eval-suspected-contradictions, post-upgrade-reembed,
 * and the new conversation-facts cathedral.
 *
 * Contract (eng review D2 + D3 + D20 + D21):
 *
 *   1. Single orchestrator + verifier+policy injection. Callers
 *      describe *how to measure success*, not *when to wait for
 *      Ctrl-C*.
 *
 *   2. Fail-CLOSED budget gate (D3). Reads
 *      `getCurrentBudgetTracker()` ahead of Policy.maxCostUsd. When
 *      BOTH are null, the primitive aborts at stage 0 with
 *      `abort_cost_cap reason='no_budget_safety_net'`. Caller must
 *      explicitly opt out via `Policy.requireBudgetSafetyNet: false`
 *      (documented in the retrofit's commit message).
 *
 *   3. Discriminated-union verifier (D20). Output-count + idempotent-
 *      mutation + noop shapes all fit. No round-peg-square-hole.
 *
 *   4. Honest behavior preservation (D21). `Policy.interactiveAbortMs:
 *      0` skips the ramp; sites that previously jumped to full keep
 *      doing so. Audit + cost-cap still apply.
 *
 * Stages (4): trial(10), ramp_100(100), ramp_500(500), full(rest).
 * Stage counts override-able via Policy.stages OR env var
 * `GBRAIN_PROGRESSIVE_BATCH_STAGES=10,100,500`.
 *
 * Env overrides:
 *   - GBRAIN_PROGRESSIVE_BATCH_DISABLED=1 — skip ramp, go to full,
 *     stderr-warn at orchestrator entry.
 *   - GBRAIN_PROGRESSIVE_BATCH_AUTO=1 — skip interactive grace
 *     window (cron / launchd / Minion workers).
 *   - GBRAIN_PROGRESSIVE_BATCH_STAGES=10,100,500 — override default
 *     stage list.
 */

import { getCurrentBudgetTracker } from '../ai/gateway.ts';
import type { BudgetTracker } from '../budget/budget-tracker.ts';
import { logProgressiveBatchEvent } from './audit.ts';
import { defaultStageReport } from './stage-report.ts';
import type {
  AbortReason,
  Policy,
  ProgressiveBatchResult,
  Stage,
  StageReport,
  StageRunner,
  StageVerdict,
  Verifier,
} from './types.ts';

/** Default stage item counts. `full` is implicit (the remainder). */
const DEFAULT_STAGES = [10, 100, 500] as const;

/** Per-spec: the 4 stage labels. Length matches DEFAULT_STAGES + 'full'. */
const STAGE_LABELS: readonly Stage[] = ['trial', 'ramp_100', 'ramp_500', 'full'];

/**
 * Generate a short operation id (8 hex chars). Used when caller
 * doesn't pass Policy.operationId. Deterministic only within a
 * process; collisions across processes are fine because we always
 * include the timestamp in the audit row.
 */
function generateOperationId(): string {
  // Math.random is fine; this is a trace id, not a security token.
  return Math.floor(Math.random() * 0xffffffff)
    .toString(16)
    .padStart(8, '0');
}

/**
 * Parse `GBRAIN_PROGRESSIVE_BATCH_STAGES` env override.
 * Returns null when unset / invalid (caller falls through to
 * Policy.stages or DEFAULT_STAGES).
 *
 * Exported for unit tests.
 */
export function parseEnvStages(raw: string | undefined): number[] | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const parts = trimmed.split(',').map((p) => p.trim());
  const nums: number[] = [];
  for (const p of parts) {
    if (!/^[1-9]\d*$/.test(p)) return null; // strict positive int
    nums.push(Number(p));
  }
  return nums.length > 0 ? nums : null;
}

/**
 * Resolve the stage item-count list. Precedence:
 *   1. env GBRAIN_PROGRESSIVE_BATCH_STAGES (if parseable)
 *   2. Policy.stages
 *   3. DEFAULT_STAGES ([10, 100, 500])
 *
 * Empty list means "skip ramp, go straight to full".
 * Exported for unit tests.
 */
export function resolveStages(policy: Policy): number[] {
  const envStages = parseEnvStages(process.env.GBRAIN_PROGRESSIVE_BATCH_STAGES);
  if (envStages !== null) return envStages;
  if (policy.stages !== undefined) return policy.stages;
  return [...DEFAULT_STAGES];
}

/**
 * Resolve the effective cost cap. Precedence (D3):
 *
 *   - When `Policy.requireBudgetSafetyNet === false`: returns the cap
 *     as-is. May be Infinity (uncapped) or a number. Caller opted
 *     out of safety; their problem.
 *
 *   - Otherwise: the LOWER of `Policy.maxCostUsd` and the active
 *     BudgetTracker's remaining headroom. If BOTH are absent → return
 *     null to signal D3 abort condition.
 *
 * Exported for unit tests.
 */
export function resolveCostCap(
  policy: Policy,
  tracker: BudgetTracker | null,
): { capUsd: number; source: 'policy' | 'tracker' | 'min' | 'uncapped' } | null {
  // Opt-out: caller takes responsibility.
  if (policy.requireBudgetSafetyNet === false) {
    if (policy.maxCostUsd !== undefined) {
      return { capUsd: policy.maxCostUsd, source: 'policy' };
    }
    return { capUsd: Infinity, source: 'uncapped' };
  }

  const policyCap = policy.maxCostUsd;
  const trackerCap = tracker ? trackerHeadroom(tracker) : null;

  if (policyCap === undefined && trackerCap === null) {
    // D3 fail-closed: neither tracker nor explicit cap → abort.
    return null;
  }
  if (policyCap !== undefined && trackerCap === null) {
    return { capUsd: policyCap, source: 'policy' };
  }
  if (policyCap === undefined && trackerCap !== null) {
    return { capUsd: trackerCap, source: 'tracker' };
  }
  // Both set: the lower wins (caller can voluntarily cap tighter).
  const minCap = Math.min(policyCap!, trackerCap!);
  return { capUsd: minCap, source: minCap === policyCap ? 'policy' : 'min' };
}

/**
 * Tracker headroom = max cap - already-spent. Returns null if the
 * tracker has no cap configured.
 */
function trackerHeadroom(tracker: BudgetTracker): number | null {
  const snapshot = tracker.snapshot();
  if (snapshot.maxCostUsd === undefined) return null;
  return Math.max(0, snapshot.maxCostUsd - snapshot.cumulativeCostUsd);
}

/**
 * Detect TTY for interactive grace. Skips when stdin OR stdout is
 * not a TTY (e.g. piped output, cron, launchd, Minion workers).
 *
 * GBRAIN_PROGRESSIVE_BATCH_AUTO=1 forces non-interactive.
 */
function isInteractive(): boolean {
  if (process.env.GBRAIN_PROGRESSIVE_BATCH_AUTO === '1') return false;
  return Boolean(process.stdin.isTTY && process.stderr.isTTY);
}

/**
 * Wait up to `ms` for a Ctrl-C (SIGINT). Resolves to `true` if
 * SIGINT was received (caller should abort). Resolves to `false`
 * if the timeout elapsed without interrupt.
 *
 * Defensively removes its listener on exit so other gbrain handlers
 * don't see double-delivery.
 *
 * Exported for unit tests (call with ms=0 to short-circuit).
 */
export function awaitInteractiveAbort(ms: number): Promise<boolean> {
  if (ms <= 0) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    let resolved = false;
    const onSigint = () => {
      if (resolved) return;
      resolved = true;
      process.off('SIGINT', onSigint);
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      process.off('SIGINT', onSigint);
      resolve(false);
    }, ms);
    process.on('SIGINT', onSigint);
  });
}

/**
 * Slice items into per-stage chunks. The final stage gets all
 * remaining items (the "full" stage).
 *
 * Examples:
 *   - 1000 items, stages=[10,100,500] → [[0..10],[10..110],[110..610],[610..1000]]
 *   - 50 items, stages=[10,100,500] → [[0..10],[10..50],[],[]]
 *     (ramp_100 takes all remaining; ramp_500 + full are empty)
 *   - 5 items, stages=[10,100,500] → [[0..5],[],[],[]]
 *   - 1000 items, stages=[] → [[],[],[],[0..1000]] (skip ramp)
 *
 * Empty slices result in a fast-pass through that stage (verdict
 * proceed, zero cost, zero delta).
 *
 * Exported for unit tests.
 */
export function sliceIntoStages<T>(
  items: T[],
  stages: number[],
): { trial: T[]; ramp_100: T[]; ramp_500: T[]; full: T[] } {
  const result: { trial: T[]; ramp_100: T[]; ramp_500: T[]; full: T[] } = {
    trial: [],
    ramp_100: [],
    ramp_500: [],
    full: [],
  };
  // If stages array is empty, dump everything into 'full'.
  if (stages.length === 0) {
    result.full = items.slice();
    return result;
  }
  let cursor = 0;
  const stageNames: ('trial' | 'ramp_100' | 'ramp_500')[] = [
    'trial',
    'ramp_100',
    'ramp_500',
  ];
  for (let i = 0; i < stageNames.length; i++) {
    const stageCount = stages[i];
    if (stageCount === undefined) break; // policy provided fewer than 3 ramp stages
    const next = Math.min(cursor + stageCount, items.length);
    result[stageNames[i]] = items.slice(cursor, next);
    cursor = next;
  }
  result.full = items.slice(cursor);
  return result;
}

/**
 * Verifier-specific delta computation. Returns
 * { observed, expected, verdict, reasons? }. The orchestrator passes
 * the verdict directly to the stage report.
 */
async function evaluateVerifier(
  verifier: Verifier,
  stage: Stage,
  itemsThisStage: number,
  countsBefore: number,
  mutationsBefore: number,
): Promise<{
  observed?: number;
  expected?: number | null;
  qualityVerdict: { ok: boolean; reasons?: string[] };
  verdict: StageVerdict;
  reason?: AbortReason;
  newMutationsBefore?: number;
}> {
  let observed: number | undefined;
  let expected: number | null = null;
  let countMismatchVerdict: StageVerdict | null = null;
  let countMismatchReason: AbortReason | undefined;
  let newMutationsBefore: number | undefined;

  switch (verifier.kind) {
    case 'output_count': {
      const after = await verifier.countAfter();
      observed = after - countsBefore;
      expected = verifier.expectedDelta(itemsThisStage);
      if (expected !== null) {
        // ±10% band (we deliberately don't make this configurable in
        // v1; D11 quick_reject + D18 priority scoring should keep
        // observed close to expected on real corpora).
        const lower = Math.floor(expected * 0.9);
        const upper = Math.ceil(expected * 1.1);
        if (observed < lower || observed > upper) {
          countMismatchVerdict = 'abort_count_mismatch';
          countMismatchReason = 'count_delta_outside_band';
        }
      }
      break;
    }
    case 'idempotent_mutation': {
      // Delta semantics: caller's mutatedCount() returns the CUMULATIVE
      // mutation counter; the orchestrator computes per-stage delta
      // against the prior snapshot. Mirrors output_count's
      // countBefore/countAfter pattern (D20 #1 fix: the v1 absolute-
      // comparison shape was wrong on stage 2+).
      const mutated = await verifier.mutatedCount();
      observed = mutated - mutationsBefore;
      const expectedFn = verifier.expectedMutations ?? ((p: number) => p);
      expected = expectedFn(itemsThisStage);
      newMutationsBefore = mutated;
      if (expected !== null) {
        const lower = Math.floor(expected * 0.9);
        const upper = Math.ceil(expected * 1.1);
        if (observed < lower || observed > upper) {
          countMismatchVerdict = 'abort_mutation_mismatch';
          countMismatchReason = 'mutation_count_outside_band';
        }
      }
      break;
    }
    case 'noop': {
      // No count check; just maybe sampleQuality.
      break;
    }
  }

  // Quality sample: only for verifiers that opt in (noop is optional).
  let qualityVerdict: { ok: boolean; reasons?: string[] } = { ok: true };
  if (
    verifier.kind === 'output_count' ||
    verifier.kind === 'idempotent_mutation' ||
    (verifier.kind === 'noop' && verifier.sampleQuality !== undefined)
  ) {
    try {
      qualityVerdict =
        verifier.kind === 'noop'
          ? await verifier.sampleQuality!()
          : await verifier.sampleQuality();
    } catch (err) {
      qualityVerdict = {
        ok: false,
        reasons: [`sampleQuality threw: ${(err as Error).message}`],
      };
    }
  }

  if (countMismatchVerdict !== null) {
    return {
      observed,
      expected,
      qualityVerdict,
      verdict: countMismatchVerdict,
      reason: countMismatchReason,
      newMutationsBefore,
    };
  }
  if (!qualityVerdict.ok) {
    return {
      observed,
      expected,
      qualityVerdict,
      verdict: 'abort_data_quality',
      reason: 'data_quality_sample_failed',
      newMutationsBefore,
    };
  }
  return {
    observed,
    expected,
    qualityVerdict,
    verdict: 'proceed',
    newMutationsBefore,
  };
}

/**
 * Run a batch through progressive stages with verification + cost
 * gating + audit. See module header for full contract.
 *
 * Generic over the caller's item type `T`. The orchestrator never
 * inspects items directly; the caller's `StageRunner` does.
 *
 * Always returns a `ProgressiveBatchResult`. Throws only on
 * unrecoverable conditions (verifier itself throwing during pre-flight
 * `countBefore`). Stage-time exceptions inside the runner are caught
 * and reported via the per-stage error rate; the orchestrator may
 * still proceed if rate stays under cap.
 */
export async function runProgressiveBatch<T>(
  items: T[],
  verifier: Verifier,
  policy: Policy,
  runner: StageRunner<T>,
): Promise<ProgressiveBatchResult> {
  const operationId = policy.operationId ?? generateOperationId();
  const label = policy.label;
  const totalItems = items.length;
  const startedAt = Date.now();
  const stageReports: StageReport[] = [];
  let cumulativeProcessed = 0;
  let cumulativeCost = 0;
  let cumulativeFailures = 0;
  let cumulativeAttempts = 0;

  // Resolve env-driven disable BEFORE anything else.
  const disabled = process.env.GBRAIN_PROGRESSIVE_BATCH_DISABLED === '1';
  if (disabled) {
    process.stderr.write(
      `[progressive-batch] DISABLED via GBRAIN_PROGRESSIVE_BATCH_DISABLED=1 — skipping ramp for label=${label}\n`,
    );
  }

  const tracker = getCurrentBudgetTracker();
  const capResult = resolveCostCap(policy, tracker);

  // D3 fail-closed safety net.
  if (capResult === null) {
    const report: StageReport = {
      operationId,
      label,
      stage: 'trial',
      itemsInStage: 0,
      itemsProcessedCumulative: 0,
      totalItems,
      verdict: 'abort_cost_cap',
      abortReason: 'no_budget_safety_net',
      errorRate: 0,
      costEstimateRunningUsd: 0,
      costProjectedFullUsd: 0,
      stageMs: 0,
    };
    stageReports.push(report);
    logProgressiveBatchEvent({
      operation_id: operationId,
      label,
      stage: 'trial',
      items_in_stage: 0,
      items_processed_cumulative: 0,
      total_items: totalItems,
      verdict: 'abort_cost_cap',
      abort_reason: 'no_budget_safety_net',
      error_rate: 0,
      cost_running_usd: 0,
      cost_projected_full_usd: 0,
      stage_ms: 0,
    });
    await emitStageReport(policy, report);
    return {
      operationId,
      label,
      totalItems,
      itemsProcessed: 0,
      stagesCompleted: [],
      abortedAt: {
        stage: 'trial',
        verdict: 'abort_cost_cap',
        reason: 'no_budget_safety_net',
      },
      totalCostUsd: 0,
      durationMs: Date.now() - startedAt,
      stageReports,
    };
  }

  const effectiveCapUsd = capResult.capUsd;

  // Capture pre-flight countBefore for output-count verifiers — used
  // by every stage so we can compute cumulative delta correctly.
  // For idempotent_mutation we also track a per-stage mutation snapshot
  // (the orchestrator updates it after each stage's verifier call).
  let countBefore = 0;
  let mutationsBefore = 0;
  if (verifier.kind === 'output_count') {
    countBefore = await verifier.countBefore();
  } else if (verifier.kind === 'idempotent_mutation') {
    mutationsBefore = await verifier.mutatedCount();
  }

  // Determine the stage list. If disabled, only 'full' runs (slice all
  // into 'full', skip ramp).
  const stages = disabled ? [] : resolveStages(policy);
  const slices = sliceIntoStages(items, stages);
  const stageSequence: { stage: Stage; slice: T[] }[] = [
    { stage: 'trial', slice: slices.trial },
    { stage: 'ramp_100', slice: slices.ramp_100 },
    { stage: 'ramp_500', slice: slices.ramp_500 },
    { stage: 'full', slice: slices.full },
  ];

  const stagesCompleted: Stage[] = [];
  const interactiveMs = policy.interactiveAbortMs ?? 0;
  const interactiveOn = interactiveMs > 0 && isInteractive() && !disabled;
  const maxErrorRate = policy.maxErrorRate ?? 0.02;

  for (let i = 0; i < stageSequence.length; i++) {
    const { stage, slice } = stageSequence[i];
    if (slice.length === 0) {
      // Fast-pass: empty stage. Don't write an audit event for noise
      // suppression unless the stage is 'full' AND total items is 0
      // (which is a degenerate but observable case).
      if (stage === 'full' && totalItems === 0) {
        // Single audit row to mark the run happened with zero items.
        const r: StageReport = {
          operationId,
          label,
          stage,
          itemsInStage: 0,
          itemsProcessedCumulative: 0,
          totalItems: 0,
          verdict: 'proceed',
          errorRate: 0,
          costEstimateRunningUsd: 0,
          costProjectedFullUsd: 0,
          stageMs: 0,
        };
        stageReports.push(r);
        await emitStageReport(policy, r);
        logProgressiveBatchEvent({
          operation_id: operationId,
          label,
          stage,
          items_in_stage: 0,
          items_processed_cumulative: 0,
          total_items: 0,
          verdict: 'proceed',
          error_rate: 0,
          cost_running_usd: 0,
          cost_projected_full_usd: 0,
          stage_ms: 0,
        });
      }
      continue;
    }

    // Run this stage's runner.
    const stageStart = Date.now();
    let succeeded = 0;
    let failed = 0;
    let stageCost = 0;
    try {
      const out = await runner(slice, stage, operationId);
      succeeded = out.succeeded;
      failed = out.failed;
      stageCost = out.costUsd;
    } catch (err) {
      // Whole-stage throw: treat as all-failed at the current slice
      // size. Surface in audit.
      failed = slice.length;
      stageCost = 0;
      process.stderr.write(
        `[progressive-batch] runner threw on stage=${stage} op=${operationId.slice(0, 8)}: ${(err as Error).message}\n`,
      );
    }
    const stageMs = Date.now() - stageStart;
    cumulativeProcessed += slice.length;
    cumulativeFailures += failed;
    cumulativeAttempts += slice.length;
    cumulativeCost += stageCost;
    const observedErrorRate =
      cumulativeAttempts > 0 ? cumulativeFailures / cumulativeAttempts : 0;

    // Cost projection: extrapolate from cost-per-item observed so far
    // (more honest than verifier.costPerItem after the first stage).
    const observedCostPerItem =
      cumulativeProcessed > 0 ? cumulativeCost / cumulativeProcessed : 0;
    const remainingItems = totalItems - cumulativeProcessed;
    const projectedRemainingCost = observedCostPerItem * remainingItems;
    const projectedFullCost = cumulativeCost + projectedRemainingCost;

    // Verifier gate.
    const vEval = await evaluateVerifier(
      verifier,
      stage,
      slice.length,
      countBefore,
      mutationsBefore,
    );
    // Advance the idempotent-mutation snapshot for the next stage.
    if (vEval.newMutationsBefore !== undefined) {
      mutationsBefore = vEval.newMutationsBefore;
    }

    // Combine signals: precedence order is
    //   1. verifier abort (count/mutation/quality)
    //   2. error rate abort
    //   3. cost cap abort (current cumulative > cap, or projection > cap)
    //   4. interactive abort (user Ctrl-C)
    //   5. caller stage-report abort
    //   6. proceed
    let verdict: StageVerdict = vEval.verdict;
    let abortReason: AbortReason | undefined = vEval.reason;
    if (verdict === 'proceed' && observedErrorRate > maxErrorRate) {
      verdict = 'abort_error_rate';
      abortReason = 'error_rate_exceeded';
    }
    if (
      verdict === 'proceed' &&
      effectiveCapUsd !== Infinity &&
      (cumulativeCost > effectiveCapUsd || projectedFullCost > effectiveCapUsd)
    ) {
      verdict = 'abort_cost_cap';
      abortReason = 'cost_projected_over_cap';
    }

    const report: StageReport = {
      operationId,
      label,
      stage,
      itemsInStage: slice.length,
      itemsProcessedCumulative: cumulativeProcessed,
      totalItems,
      verdict,
      abortReason,
      errorRate: observedErrorRate,
      costEstimateRunningUsd: cumulativeCost,
      costProjectedFullUsd: projectedFullCost,
      deltaObserved: vEval.observed,
      deltaExpected: vEval.expected,
      stageMs,
      qualityReasons:
        vEval.qualityVerdict.reasons && vEval.qualityVerdict.reasons.length > 0
          ? vEval.qualityVerdict.reasons
          : undefined,
    };

    // Emit report (caller may signal abort).
    const callerResp = await emitStageReport(policy, report);
    if (callerResp?.abort && verdict === 'proceed') {
      verdict = 'abort_explicit';
      abortReason = 'caller_signaled_abort';
      report.verdict = verdict;
      report.abortReason = abortReason;
    }

    stageReports.push(report);
    logProgressiveBatchEvent({
      operation_id: operationId,
      label,
      stage,
      items_in_stage: slice.length,
      items_processed_cumulative: cumulativeProcessed,
      total_items: totalItems,
      verdict,
      abort_reason: abortReason,
      error_rate: observedErrorRate,
      cost_running_usd: cumulativeCost,
      cost_projected_full_usd: projectedFullCost,
      delta_observed: vEval.observed,
      delta_expected: vEval.expected,
      stage_ms: stageMs,
      quality_reasons: report.qualityReasons,
    });

    if (verdict !== 'proceed') {
      return {
        operationId,
        label,
        totalItems,
        itemsProcessed: cumulativeProcessed,
        stagesCompleted,
        abortedAt: { stage, verdict, reason: abortReason },
        totalCostUsd: cumulativeCost,
        durationMs: Date.now() - startedAt,
        stageReports,
      };
    }

    stagesCompleted.push(stage);

    // Interactive grace window between stages (NOT after 'full').
    if (interactiveOn && i < stageSequence.length - 1) {
      const nextSlice = stageSequence[i + 1].slice;
      if (nextSlice.length > 0) {
        process.stderr.write(
          `[progressive-batch] ${stage} complete; ${nextSlice.length} items in next stage. ` +
            `Press Ctrl-C within ${interactiveMs}ms to abort.\n`,
        );
        const aborted = await awaitInteractiveAbort(interactiveMs);
        if (aborted) {
          const r: StageReport = {
            operationId,
            label,
            stage,
            itemsInStage: 0,
            itemsProcessedCumulative: cumulativeProcessed,
            totalItems,
            verdict: 'abort_user',
            abortReason: 'user_aborted',
            errorRate: observedErrorRate,
            costEstimateRunningUsd: cumulativeCost,
            costProjectedFullUsd: projectedFullCost,
            stageMs: 0,
          };
          stageReports.push(r);
          await emitStageReport(policy, r);
          logProgressiveBatchEvent({
            operation_id: operationId,
            label,
            stage,
            items_in_stage: 0,
            items_processed_cumulative: cumulativeProcessed,
            total_items: totalItems,
            verdict: 'abort_user',
            abort_reason: 'user_aborted',
            error_rate: observedErrorRate,
            cost_running_usd: cumulativeCost,
            cost_projected_full_usd: projectedFullCost,
            stage_ms: 0,
          });
          return {
            operationId,
            label,
            totalItems,
            itemsProcessed: cumulativeProcessed,
            stagesCompleted,
            abortedAt: { stage, verdict: 'abort_user', reason: 'user_aborted' },
            totalCostUsd: cumulativeCost,
            durationMs: Date.now() - startedAt,
            stageReports,
          };
        }
      }
    }
  }

  return {
    operationId,
    label,
    totalItems,
    itemsProcessed: cumulativeProcessed,
    stagesCompleted,
    totalCostUsd: cumulativeCost,
    durationMs: Date.now() - startedAt,
    stageReports,
  };
}

/**
 * Invoke caller's stage-report callback if provided, otherwise the
 * default stderr writer. Honors a `Promise<void | StageReportResponse>`
 * shape uniformly.
 */
async function emitStageReport(
  policy: Policy,
  report: StageReport,
): Promise<{ abort?: boolean; rewriteRemainingStages?: number[] } | undefined> {
  const handler = policy.onStageReport ?? ((r: StageReport) => defaultStageReport(r));
  try {
    const r = await handler(report);
    if (r === undefined || r === null) return undefined;
    return r;
  } catch (err) {
    process.stderr.write(
      `[progressive-batch] onStageReport threw (continuing): ${(err as Error).message}\n`,
    );
    return undefined;
  }
}

/**
 * Re-export the public types so callers can do
 *   `import { runProgressiveBatch, type Verifier } from 'gbrain/progressive-batch'`
 * without dragging in the internal audit/types/stage-report modules.
 */
export type {
  AbortReason,
  IdempotentMutationVerifier,
  NoopVerifier,
  OutputCountVerifier,
  Policy,
  ProgressiveBatchResult,
  QualityVerdict,
  Stage,
  StageReport,
  StageReportResponse,
  StageRunner,
  StageVerdict,
  Verifier,
} from './types.ts';
