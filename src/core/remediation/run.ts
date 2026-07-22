// src/core/remediation/run.ts
// v0.41.18.0 (A1, codex finding #2). Extracted from doctor.ts:runRemediate
// so onboard + MCP run_onboard call the same orchestrator without parsing
// argv or invoking process.exit / console.* directly.
//
// The orchestrator wraps the plan loop with:
//   - BudgetTracker (auto-installed via withBudgetTracker)
//   - Checkpoint resume per A4 amended (matching plan_hash only)
//   - D5 dependency cascade (failed step aborts dependents)
//   - D7 per-step recheck (re-compute plan from fresh health)
//   - Hooks for caller observability (no console.* in the library)

import crypto from 'crypto';
import type { BrainEngine } from '../engine.ts';
import {
  computeRecommendations,
} from '../brain-score-recommendations.ts';
import type { RemediationStep } from '../remediation-step.ts';
import { loadRecommendationContext } from './context.ts';
import { computeRemediationPlan } from './plan.ts';
import type {
  RemediationHooks,
  RemediationOpts,
  RemediationResult,
  StepResult,
} from './types.ts';

/**
 * Submit ordered Remediation jobs sequentially per D3, with D5 cascade
 * on failure and D7 scoped recheck between steps.
 *
 * PGLite path: synchronous in-process execution (no durable queue).
 *
 * Returns a RemediationResult; never throws on BudgetExhausted (the
 * exhaustion snapshot lives on result.budget_exhausted instead).
 * Other thrown errors propagate.
 *
 * Callers decide exit codes from the result.
 */
export async function runRemediation(
  engine: BrainEngine,
  opts: RemediationOpts = {},
  hooks: RemediationHooks = {},
): Promise<RemediationResult> {
  const targetScore = opts.targetScore ?? 90;
  const maxJobs = opts.maxJobs ?? Infinity;
  const maxUsd = opts.maxUsd;
  const dryRun = opts.dryRun ?? false;
  const resumeMode = opts.resume ?? false;
  const resumePlanHash = opts.resumePlanHash;

  // Lazy-load orchestration deps so the library entry-point doesn't pay
  // their cost on a --dry-run shortcut path (or when callers only need
  // computeRemediationPlan).
  const {
    BudgetTracker,
    BudgetExhausted,
  } = await import('../budget/budget-tracker.ts');
  const { withBudgetTracker } = await import('../ai/gateway.ts');
  const {
    computePlanHash,
    saveRemediationCheckpoint,
    loadRemediationCheckpoint,
    listRemediationCheckpoints,
    clearRemediationCheckpoint,
  } = await import('../remediation-checkpoint.ts');

  const ctx = await loadRecommendationContext(engine);

  // Pre-flight ceiling check via the shared plan computation.
  const initialPlan = await computeRemediationPlan(engine, { targetScore });
  if (initialPlan.target_unreachable) {
    hooks.onTargetUnreachable?.(targetScore, initialPlan.max_reachable_score);
    return {
      doctor_run_id: crypto.randomUUID(),
      brain_score_initial: initialPlan.brain_score_current,
      brain_score_final: initialPlan.brain_score_current,
      brain_score_target: targetScore,
      target_reached: false,
      submitted: [],
      aborted_count: 0,
      target_unreachable: {
        target: targetScore,
        ceiling: initialPlan.max_reachable_score,
      },
    };
  }

  const initialHealth = await engine.getHealth();
  let recs: RemediationStep[] = computeRecommendations(initialHealth, ctx)
    .filter((r) => r.status === 'remediable');
  if (recs.length === 0) {
    hooks.onNothingToDo?.(initialHealth.brain_score, targetScore);
    return {
      doctor_run_id: crypto.randomUUID(),
      brain_score_initial: initialHealth.brain_score,
      brain_score_final: initialHealth.brain_score,
      brain_score_target: targetScore,
      target_reached: initialHealth.brain_score >= targetScore,
      submitted: [],
      aborted_count: 0,
    };
  }

  // A4 amended: compute plan_hash off the active recommendation ids so
  // the checkpoint binds to THIS plan. Resume only fires for matching plans.
  const planHash = computePlanHash(recs.map((r) => r.id));
  let completedFromCheckpoint = new Set<string>();
  if (resumeMode) {
    const requested = resumePlanHash;
    let cp = requested ? loadRemediationCheckpoint(requested) : null;
    if (!cp && !requested) {
      // No explicit hash: try newest checkpoint that matches the active plan.
      const recent = listRemediationCheckpoints();
      for (const e of recent) {
        const candidate = loadRemediationCheckpoint(e.plan_hash);
        if (candidate && candidate.plan_hash === planHash) {
          cp = candidate;
          break;
        }
      }
    }
    if (!cp || cp.plan_hash !== planHash) {
      hooks.onResumeMissed?.(planHash, requested);
      // Surface as a synthetic result so the CLI shell can exit 2.
      return {
        doctor_run_id: crypto.randomUUID(),
        brain_score_initial: initialHealth.brain_score,
        brain_score_final: initialHealth.brain_score,
        brain_score_target: targetScore,
        target_reached: false,
        submitted: [],
        aborted_count: 0,
        target_unreachable: {
          target: targetScore,
          ceiling: initialPlan.max_reachable_score,
        },
      };
    }
    completedFromCheckpoint = new Set(cp.completed.map((c) => c.id));
    hooks.onResumeLoaded?.(
      planHash,
      completedFromCheckpoint.size,
      recs.length - completedFromCheckpoint.size,
    );
  }

  const estTotalUsd = recs.reduce((sum, r) => sum + (r.est_usd_cost ?? 0), 0);
  if (maxUsd !== undefined && estTotalUsd > maxUsd) {
    hooks.onBudgetRefused?.(estTotalUsd, maxUsd);
    return {
      doctor_run_id: crypto.randomUUID(),
      brain_score_initial: initialHealth.brain_score,
      brain_score_final: initialHealth.brain_score,
      brain_score_target: targetScore,
      target_reached: false,
      submitted: [],
      aborted_count: 0,
    };
  }

  if (dryRun) {
    // Dry-run: no submission, just return the plan as a non-empty result.
    // Each rec lands in submitted[] with synthetic 'dry_run' status so the
    // shape stays consistent.
    return {
      doctor_run_id: crypto.randomUUID(),
      brain_score_initial: initialHealth.brain_score,
      brain_score_final: initialHealth.brain_score,
      brain_score_target: targetScore,
      target_reached: false,
      submitted: recs.map((r, i) => ({
        step: i + 1,
        id: r.id,
        job_id: null,
        status: 'dry_run',
      })),
      aborted_count: 0,
    };
  }

  // Real submission path
  const submitted: StepResult[] = [];
  const abortedIds = new Set<string>();
  const doctorRunId = crypto.randomUUID();

  const { MinionQueue } = await import('../minions/queue.ts');
  const { waitForCompletion } = await import('../minions/wait-for-completion.ts');
  const isPGLite = engine.kind === 'pglite';
  const queue = new MinionQueue(engine);

  // A4 amended: install a BudgetTracker scope around the plan-step loop so
  // any gateway.chat / embed / rerank inside a Minion handler (synthesize,
  // patterns, consolidate) auto-enforces the cap. On BudgetExhausted, the
  // onExhausted callback persists the checkpoint BEFORE the throw propagates;
  // the caller hook surfaces the actionable --resume hint.
  const remediateTracker = new BudgetTracker({
    label: 'remediation.run',
    maxCostUsd: maxUsd,
  });

  let exhaustionSnapshot: NonNullable<RemediationResult['budget_exhausted']> | undefined;
  remediateTracker.onExhausted(() => {
    const cp = {
      schema_version: 1 as const,
      plan_hash: planHash,
      doctor_run_id: doctorRunId,
      target_score: targetScore,
      started_at: new Date().toISOString(),
      completed: submitted
        .filter((s) => s.status === 'completed')
        .map((s) => ({ id: s.id, job: '', status: s.status, job_id: s.job_id ?? null })),
      aborted_at: new Date().toISOString(),
      abort_reason: 'budget_exhausted' as const,
      budget_snapshot: exhaustionSnapshot
        ? { spent: exhaustionSnapshot.spent, cap: exhaustionSnapshot.cap, reason: exhaustionSnapshot.reason, model_id: exhaustionSnapshot.model_id }
        : undefined,
    };
    saveRemediationCheckpoint(cp);
  });

  const runLoop = async (): Promise<void> => {
    let stepCount = 0;
    const totalSteps = recs.length;
    while (recs.length > 0 && stepCount < maxJobs) {
      const step = recs[0];
      if (!step) break;
      stepCount++;

      // Resume: skip steps that the checkpoint already marked completed.
      if (completedFromCheckpoint.has(step.id)) {
        const result: StepResult = { step: stepCount, id: step.id, job_id: null, status: 'completed' };
        submitted.push(result);
        hooks.onStepEnd?.(result);
        recs.shift();
        continue;
      }

      // D5: if depends_on intersects aborted, skip + cascade
      if (step.depends_on && step.depends_on.some((d: string) => abortedIds.has(d))) {
        const result: StepResult = { step: stepCount, id: step.id, job_id: null, status: 'skipped_dep_aborted' };
        submitted.push(result);
        abortedIds.add(step.id);
        hooks.onStepEnd?.(result);
        recs.shift();
        continue;
      }

      hooks.onStepStart?.(stepCount, totalSteps, step);
      try {
        const isProtected = !!step.protected;
        const job = await queue.add(
          step.job,
          { ...step.params, doctor_run_id: doctorRunId },
          {
            queue: 'default',
            idempotency_key: step.idempotency_key,
            max_attempts: 2,
            maxWaiting: 1,
          },
          isProtected ? { allowProtectedSubmit: true } : undefined,
        );
        const submittedResult: StepResult = {
          step: stepCount,
          id: step.id,
          job_id: job.id,
          status: 'submitted',
        };
        submitted.push(submittedResult);

        const terminal = await waitForCompletion(queue, job.id, {
          pollMs: isPGLite ? 250 : 1000,
          timeoutMs: (step.est_seconds + 60) * 1000,
        });
        submittedResult.status = terminal.status;
        if (terminal.status !== 'completed') {
          abortedIds.add(step.id);
        }
        hooks.onStepEnd?.(submittedResult);
      } catch (e) {
        if (e instanceof BudgetExhausted) {
          exhaustionSnapshot = {
            spent: e.spent,
            cap: e.cap,
            reason: e.reason,
            model_id: e.modelId,
            plan_hash: planHash,
          };
          throw e;
        }
        const errResult: StepResult = {
          step: stepCount,
          id: step.id,
          job_id: null,
          status: `error: ${(e as Error).message.slice(0, 100)}`,
        };
        submitted.push(errResult);
        abortedIds.add(step.id);
        hooks.onStepEnd?.(errResult);
      }

      recs.shift();
      // D7: scoped recheck — re-compute plan from fresh health snapshot.
      // The next plan may drop completed steps and re-introduce failed
      // steps with bumped retry suffix (D1).
      if (recs.length === 0 || stepCount >= maxJobs) break;
      const freshHealth = await engine.getHealth();
      recs = computeRecommendations(freshHealth, ctx).filter((r) => r.status === 'remediable');
    }
  };

  let budgetAbort: NonNullable<RemediationResult['budget_exhausted']> | undefined;
  try {
    await withBudgetTracker(remediateTracker, runLoop);
  } catch (err) {
    if (err instanceof BudgetExhausted) {
      budgetAbort = exhaustionSnapshot;
      if (budgetAbort) hooks.onBudgetExhausted?.(planHash, budgetAbort);
    } else {
      throw err;
    }
  }

  // Clear checkpoint on a clean run (no budget abort). Failed steps in the
  // submitted set don't disqualify the cleanup — they re-surface on the
  // next plan with bumped suffixes.
  if (!budgetAbort) {
    clearRemediationCheckpoint(planHash);
  }

  const finalHealth = await engine.getHealth();
  return {
    doctor_run_id: doctorRunId,
    brain_score_initial: initialHealth.brain_score,
    brain_score_final: finalHealth.brain_score,
    brain_score_target: targetScore,
    target_reached: finalHealth.brain_score >= targetScore,
    submitted,
    aborted_count: abortedIds.size,
    budget_exhausted: budgetAbort,
  };
}
