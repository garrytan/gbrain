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
import { queueWorkerAlive } from '../minions/no-worker.ts';
import {
  computeRecommendations,
} from '../brain-score-recommendations.ts';
import type { RemediationStep } from '../remediation-step.ts';
import { loadRecommendationContext } from './context.ts';
import { computeRemediationPlan } from './plan.ts';
import { planRepairStepsReport, previewFailureField, runRepairSteps, type RepairPlanStep, type RepairPreviewFailure, type RepairStepResult } from './repairs.ts';
import { OperationError } from '../ops/contract.ts';
import type { RemediationCheckpoint } from '../remediation-checkpoint.ts';
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
/**
 * E3: the job steps a run executes. An unreachable score target skips the
 * PAID steps only (their ids land in `job_steps_skipped.skipped`); free steps
 * still run so the brain improves as far as it can — when a worker serves the
 * queue. With no worker (PGLite, or no supervisor) they would wait out their
 * timeout, so every job step is skipped as before.
 */
function planJobSteps(planned: RemediationStep[], manifest: { job_ids: string[] } | undefined, unreachable?: { target: number; ceiling: number }) {
  const remediable = planned.filter((r) => r.status === 'remediable' && (!manifest || manifest.job_ids.includes(r.id)));
  const workerRuns = !unreachable || queueWorkerAlive('default') === true;
  const freeRecs = workerRuns ? remediable.filter((r) => (r.est_usd_cost ?? 0) === 0) : [];
  if (!unreachable) return { recs: remediable, freeRecs, jobStepsSkipped: undefined };
  return {
    recs: freeRecs, freeRecs,
    jobStepsSkipped: { reason: 'target_unreachable' as const, ...unreachable, skipped: remediable.filter((r) => !freeRecs.includes(r)).map((r) => r.id) },
  };
}

/**
 * How a submitted step is awaited. PGLite has no background worker, and a
 * Postgres queue may have none running: when the caller allows it and no
 * registered worker serves the queue, the step runs in this process (as `jobs submit --follow` does)
 * instead of waiting out its timeout for a worker that never comes.
 */
function stepWaiter(engine: BrainEngine, queue: InstanceType<typeof import('../minions/queue.ts').MinionQueue>, allowInline: boolean) {
  const worker = allowInline ? queueWorkerAlive('default') : true;
  const inline = engine.kind === 'pglite' ? worker !== true : worker === false;
  return async (jobId: number, waitOpts: { pollMs: number; timeoutMs: number }) => {
    if (inline) return runJobInline(engine, queue, jobId, waitOpts);
    const { waitForCompletion } = await import('../minions/wait-for-completion.ts');
    return waitForCompletion(queue, jobId, waitOpts);
  };
}

/** One submitted job, executed by an in-process worker until it is terminal. */
async function runJobInline(
  engine: BrainEngine,
  queue: InstanceType<typeof import('../minions/queue.ts').MinionQueue>,
  jobId: number,
  waitOpts: { pollMs: number; timeoutMs: number },
) {
  const { MinionWorker } = await import('../minions/worker.ts');
  const { registerBuiltinHandlers } = await import('../../commands/jobs.ts');
  const { waitForCompletion } = await import('../minions/wait-for-completion.ts');
  const worker = new MinionWorker(engine, { queue: 'default', pollInterval: 100, healthCheckInterval: 0 });
  await registerBuiltinHandlers(worker, engine);
  const running = worker.start();
  try {
    return await waitForCompletion(queue, jobId, waitOpts);
  } finally {
    worker.stop();
    await running;
  }
}

export async function runRemediation(
  engine: BrainEngine,
  opts: RemediationOpts = {},
  hooks: RemediationHooks = {},
): Promise<RemediationResult> {
  const targetScore = opts.targetScore ?? 90;
  const maxJobs = opts.maxJobs ?? Infinity;
  const dryRun = opts.dryRun ?? false;
  const resumeMode = opts.resume ?? false;
  const resumePlanHash = opts.resumePlanHash;
  const repairs = opts.repairs;
  if (repairs?.include && repairs.remote !== false) {
    throw new OperationError('permission_denied', 'Repair steps are PROTECTED: only a trusted local caller on the brain host can include them.',
      'On the brain host, run: gbrain doctor --remediation-plan');
  }

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
  const extraRemediations = opts.extraRemediations ?? [];
  const brainId = repairs ? (await (await import('../repair/core.ts')).resolveRepairScope(engine)).brain_id : undefined;
  let previewFailures: RepairPreviewFailure[] = [];
  const synthetic = (score: number, extra: Partial<RemediationResult> = {}): RemediationResult => ({
    doctor_run_id: crypto.randomUUID(), brain_score_initial: score, brain_score_final: score, brain_score_target: targetScore,
    target_reached: false, submitted: [], aborted_count: 0, ...previewFailureField(previewFailures), ...extra,
  });

  // Resume loads its checkpoint first: a checkpoint that records a manifest
  // binds the run to its brain, cap, consent and original steps.
  let cp: RemediationCheckpoint | null = null;
  if (resumeMode) {
    cp = resumePlanHash ? loadRemediationCheckpoint(resumePlanHash) : null;
    if (!cp && !resumePlanHash) {
      for (const e of listRemediationCheckpoints()) {
        const candidate = loadRemediationCheckpoint(e.plan_hash);
        if (candidate?.manifest && brainId && candidate.brain_id === brainId) { cp = candidate; break; }
      }
    }
    if (cp?.manifest && brainId && cp.brain_id !== brainId) {
      hooks.onResumeBrainMismatch?.(cp.plan_hash, cp.brain_id ?? 'unknown', brainId);
      const health = await engine.getHealth();
      return synthetic(health.brain_score, { resume_refused: { reason: 'brain_mismatch', checkpoint_brain_id: cp.brain_id ?? 'unknown', brain_id: brainId, plan_hash: cp.plan_hash } });
    }
  }
  const manifest = cp?.manifest;
  // The cap is cumulative: a resume without --max-usd reuses the recorded cap,
  // and spend already settled by the original run and earlier resumes counts.
  const maxUsd = opts.maxUsd ?? (manifest ? cp?.max_usd ?? undefined : undefined);
  const spentBefore = manifest ? cp?.spent_usd ?? 0 : 0;
  if (manifest) hooks.onResumeCap?.(maxUsd ?? null, spentBefore);
  const includeRepairs = repairs !== undefined && (repairs.include || (manifest !== undefined && cp?.include_repairs === true));

  // Pre-flight ceiling check via the shared plan computation. The score target
  // governs job steps only; repair steps are planned independently of it.
  const initialPlan = await computeRemediationPlan(engine, { targetScore, extraRemediations });
  const repairReport = repairs ? await planRepairStepsReport(engine, { noEmbed: repairs.noEmbed, kinds: manifest ? manifest.repair_kinds as RepairPlanStep['kind'][] : undefined, registry: repairs.registry }) : { steps: [], previewFailures: [] };
  let repairSteps: RepairPlanStep[] = repairReport.steps;
  previewFailures = repairReport.previewFailures;
  // Embeddings a budget stop left behind after re-sealing; the re-sealed pages no longer show up in a repair plan.
  let pendingEmbedSources = includeRepairs && manifest ? [...(cp?.pending_embed_sources ?? [])] : [];
  const initialHealth = await engine.getHealth();
  const { freeRecs, jobStepsSkipped, recs: plannedJobSteps } = planJobSteps(computeRecommendations(initialHealth, ctx, extraRemediations), manifest,
    initialPlan.target_unreachable ? { target: targetScore, ceiling: initialPlan.max_reachable_score } : undefined);
  if (jobStepsSkipped && freeRecs.length === 0 && !(includeRepairs && (repairSteps.length || pendingEmbedSources.length))) {
    hooks.onTargetUnreachable?.(targetScore, initialPlan.max_reachable_score);
    return synthetic(initialPlan.brain_score_current, {
      target_unreachable: { target: targetScore, ceiling: initialPlan.max_reachable_score },
      ...(repairs && repairSteps.length ? { repairs: [], repairs_skipped: repairSteps } : {}),
    });
  }
  if (jobStepsSkipped) hooks.onTargetUnreachable?.(targetScore, initialPlan.max_reachable_score);
  let recs: RemediationStep[] = plannedJobSteps;
  const skippedRepairs = includeRepairs ? [] : repairSteps;
  if (!includeRepairs) repairSteps = [];
  if (recs.length === 0 && repairSteps.length === 0 && pendingEmbedSources.length === 0) {
    hooks.onNothingToDo?.(initialHealth.brain_score, targetScore);
    return {
      ...synthetic(initialHealth.brain_score),
      target_reached: initialHealth.brain_score >= targetScore,
      ...(jobStepsSkipped ? { job_steps_skipped: jobStepsSkipped } : {}),
      ...(repairs ? { repairs: [], repairs_skipped: skippedRepairs } : {}),
    };
  }

  // A4 amended: compute plan_hash off the active step ids so the checkpoint
  // binds to THIS plan. A checkpoint with a manifest keeps its original hash.
  // The brain id is part of the hash so two brains on one host never share a checkpoint file.
  const planHash = cp?.manifest ? cp.plan_hash : computePlanHash([...recs.map((r) => r.id), ...repairSteps.map((r) => r.id), ...(brainId ? [`brain:${brainId}`] : [])]);
  const originalManifest = manifest ?? { job_ids: recs.map((r) => r.id), repair_kinds: repairSteps.map((r) => r.kind) };
  let completedFromCheckpoint = new Set<string>();
  if (resumeMode) {
    if (!cp && !resumePlanHash) {
      // Legacy checkpoints (no manifest) resume only the identical job plan.
      for (const e of listRemediationCheckpoints()) {
        const candidate = loadRemediationCheckpoint(e.plan_hash);
        if (candidate && !candidate.manifest && candidate.plan_hash === planHash) { cp = candidate; break; }
      }
    }
    if (!cp || (!cp.manifest && cp.plan_hash !== planHash)) {
      hooks.onResumeMissed?.(planHash, resumePlanHash);
      // Surface as a synthetic result so the CLI shell can exit 2.
      return synthetic(initialHealth.brain_score, { target_unreachable: { target: targetScore, ceiling: initialPlan.max_reachable_score } });
    }
    completedFromCheckpoint = new Set(cp.completed.map((c) => c.id));
    repairSteps = repairSteps.filter((step) => !completedFromCheckpoint.has(step.id));
    hooks.onResumeLoaded?.(
      planHash,
      completedFromCheckpoint.size,
      recs.filter((r) => !completedFromCheckpoint.has(r.id)).length + repairSteps.length,
    );
  }

  const remainingCap = maxUsd === undefined ? undefined : Math.max(0, maxUsd - spentBefore);
  const estJobUsd = recs.reduce((sum, r) => sum + (r.est_usd_cost ?? 0), 0);
  let jobsBudgetRefused = false;
  if (remainingCap !== undefined && estJobUsd > remainingCap) {
    hooks.onBudgetRefused?.(estJobUsd, remainingCap);
    if (repairSteps.length === 0) return synthetic(initialHealth.brain_score, repairs ? { repairs: [], repairs_skipped: skippedRepairs } : {});
    jobsBudgetRefused = true;
    recs = [];
  }

  if (dryRun) {
    // Dry-run: no submission, just return the plan as a non-empty result.
    // Each rec lands in submitted[] with synthetic 'dry_run' status so the
    // shape stays consistent.
    return {
      ...synthetic(initialHealth.brain_score),
      submitted: [...repairSteps.map((r) => r.id), ...recs.map((r) => r.id)].map((id, i) => ({ step: i + 1, id, job_id: null, status: 'dry_run' })),
      ...(repairs ? { repairs: [], repairs_skipped: skippedRepairs } : {}),
    };
  }

  // Real submission path
  const submitted: StepResult[] = [];
  const abortedIds = new Set<string>();
  const attemptedIds = new Set<string>();
  const doctorRunId = crypto.randomUUID();
  const repairResults: RepairStepResult[] = [];

  const { MinionQueue } = await import('../minions/queue.ts');
  const { openStepImpact, closeStepImpact } = await import('../onboard/impact-capture.ts');
  const isPGLite = engine.kind === 'pglite';
  const queue = new MinionQueue(engine);
  const waitStep = stepWaiter(engine, queue, opts.inlineJobs === true);

  // A4 amended: install a BudgetTracker scope around the plan-step loop so
  // any gateway.chat / embed / rerank inside a Minion handler (synthesize,
  // patterns, consolidate) or a repair step auto-enforces the cap. On
  // BudgetExhausted, the onExhausted callback persists the checkpoint BEFORE
  // the throw propagates; the caller hook surfaces the actionable --resume hint.
  // Repairs run first under their own tracker; job steps then get a tracker capped at what the repairs left,
  // so in-process spend, reserved effect estimates and job spend all draw on one cumulative cap.
  const repairTracker = new BudgetTracker({ label: 'remediation.repairs', maxCostUsd: remainingCap, capSource: opts.capSource });
  let jobTracker: InstanceType<typeof BudgetTracker> | undefined;
  // Effect kinds embed outside any tracker, so their estimate is reserved up front; paid-model spend no tracker here metered is charged once its step reports it.
  let reservedUsd = 0;
  let trackerExhausted = false;
  const stepTrackers: Array<InstanceType<typeof BudgetTracker>> = [];
  const spentThisRun = () => repairTracker.totalSpent + reservedUsd + (jobTracker?.totalSpent ?? 0)
    + stepTrackers.reduce((sum, tracker) => sum + tracker.totalSpent, 0);
  const settledUsd = () => spentBefore + spentThisRun();
  const remainingUsd = () => remainingCap === undefined ? undefined : Math.max(0, remainingCap - spentThisRun());

  let exhaustionSnapshot: NonNullable<RemediationResult['budget_exhausted']> | undefined;
  const saveCheckpoint = () => {
    const completed = [
      ...[...completedFromCheckpoint].map((id) => ({ id, job: '', status: 'completed' })),
      ...submitted.filter((s) => s.status === 'completed' && !completedFromCheckpoint.has(s.id))
        .map((s) => ({ id: s.id, job: '', status: s.status, job_id: s.job_id ?? null })),
      ...repairResults.filter((r) => r.status === 'completed').map((r) => ({ id: r.id, job: 'repair', status: r.status })),
    ];
    saveRemediationCheckpoint({
      schema_version: 1 as const,
      plan_hash: planHash,
      doctor_run_id: doctorRunId,
      target_score: targetScore,
      started_at: new Date().toISOString(),
      completed,
      aborted_at: new Date().toISOString(),
      abort_reason: 'budget_exhausted' as const,
      budget_snapshot: exhaustionSnapshot
        ? { spent: exhaustionSnapshot.spent, cap: exhaustionSnapshot.cap, reason: exhaustionSnapshot.reason, model_id: exhaustionSnapshot.model_id }
        : undefined,
      ...(repairs ? {
        brain_id: brainId, max_usd: maxUsd ?? null, include_repairs: includeRepairs,
        spent_usd: settledUsd(), manifest: originalManifest,
        ...(pendingEmbedSources.length ? { pending_embed_sources: pendingEmbedSources } : {}),
      } : {}),
    });
  };
  const watch = (tracker: InstanceType<typeof BudgetTracker>) => {
    tracker.onExhausted(() => { trackerExhausted = true; });
    tracker.onExhausted(saveCheckpoint);
  };
  watch(repairTracker);

  const runRepairs = async (): Promise<void> => {
    if (!repairs) return;
    if (pendingEmbedSources.length) {
      const { embedStaleForSource } = await import('../embed-stale.ts');
      let status: RepairStepResult['status'] = 'completed';
      let embedded = 0;
      if (remainingUsd() === 0) status = 'budget_refused';
      for (const sourceId of status === 'completed' ? [...pendingEmbedSources] : []) {
        if (trackerExhausted) break;
        let result: Awaited<ReturnType<typeof embedStaleForSource>> | undefined;
        try { result = await embedStaleForSource(engine, sourceId); } catch (error) { if (!(error instanceof BudgetExhausted)) throw error; }
        embedded += result?.embedded ?? 0;
        // A source is done only when the pass finished without leaving chunks behind.
        if (!trackerExhausted && result && !result.failures && result.complete !== false && !result.remaining) {
          pendingEmbedSources = pendingEmbedSources.filter((id) => id !== sourceId);
        }
      }
      if (trackerExhausted) status = 'budget_exhausted';
      else if (status === 'completed' && pendingEmbedSources.length) status = 'stopped';
      repairResults.push({ id: 'repair:safe-chunks:embeddings', kind: 'safe-chunks', status, applied: embedded, skipped: 0,
        ...(status === 'budget_exhausted' || status === 'budget_refused' ? { message: 'The --max-usd budget does not cover the embeddings of re-sealed pages; resume with a higher cap to continue.' }
          : status === 'stopped' ? { message: `Some re-sealed pages still lack embeddings (${pendingEmbedSources.join(', ')}); check the embedding provider, then run gbrain embed --stale.` } : {}) });
    }
    if (repairSteps.length === 0) return;
    for (const step of repairSteps) hooks.onRepairStepStart?.(step);
    const results = await runRepairSteps(engine, repairSteps, { remote: repairs.remote, noEmbed: repairs.noEmbed, remainingUsd, registry: repairs.registry,
      charge: (usd) => { reservedUsd += usd; }, spentUsd: spentThisRun, exhausted: () => trackerExhausted,
      stepBudget: async (run) => {
        const tracker = new BudgetTracker({ label: 'remediation.repair-step', maxCostUsd: remainingUsd(), capSource: opts.capSource });
        stepTrackers.push(tracker);
        watch(tracker);
        return withBudgetTracker(tracker, run);
      },
      onStep: (step, result) => hooks.onRepairStepEnd?.(step, result) });
    repairResults.push(...results);
    // A re-seal whose embeddings the budget cut short resumes as an embedding pass over the same sources.
    if (results.some((r) => r.kind === 'safe-chunks' && r.status === 'budget_exhausted')) {
      pendingEmbedSources = [...new Set([...pendingEmbedSources, ...(await (await import('../repair/core.ts')).resolveRepairScope(engine)).source_ids])];
    }
  };

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
        attemptedIds.add(step.id);
        hooks.onStepEnd?.(result);
        recs.shift();
        continue;
      }

      // D5: if depends_on intersects aborted, skip + cascade
      if (step.depends_on && step.depends_on.some((d: string) => abortedIds.has(d))) {
        const result: StepResult = { step: stepCount, id: step.id, job_id: null, status: 'skipped_dep_aborted' };
        submitted.push(result);
        abortedIds.add(step.id);
        attemptedIds.add(step.id);
        hooks.onStepEnd?.(result);
        recs.shift();
        continue;
      }

      hooks.onStepStart?.(stepCount, totalSteps, step);
      try {
        const impact = await openStepImpact(engine, step);
        const isProtected = !!step.protected;
        const submitWith = (key: string) =>
          queue.add(
            step.job,
            { ...step.params, doctor_run_id: doctorRunId },
            {
              queue: 'default',
              idempotency_key: key,
              max_attempts: 2,
              maxWaiting: 1,
            },
            isProtected ? { allowProtectedSubmit: true } : undefined,
          );
        let job = await submitWith(step.idempotency_key);
        let dedupedJobId: number | undefined;
        if (job.coalesced && (job.status === 'completed' || job.status === 'failed')) {
          // #3626: the content-hash key never rotates and the queue frees a
          // key only for dead/cancelled rows — a completed/failed row from a
          // PRIOR run holds it forever, so every later --remediate "ran" this
          // step as an instant no-op against the old terminal row. Rotate
          // ONCE onto this run's id so the work actually re-executes.
          // Waiting/active rows still coalesce (dedupe onto in-flight work).
          dedupedJobId = job.id;
          job = await submitWith(`${step.idempotency_key}:r:${doctorRunId}`);
        }
        const submittedResult: StepResult = {
          step: stepCount,
          id: step.id,
          job_id: job.id,
          status: 'submitted',
          ...(job.coalesced === true ? { coalesced: true } : {}),
          ...(dedupedJobId !== undefined ? { deduped_job_id: dedupedJobId } : {}),
        };
        submitted.push(submittedResult);

        const terminal = await waitStep(job.id, { pollMs: isPGLite ? 250 : 1000, timeoutMs: (step.est_seconds + 60) * 1000 });
        submittedResult.status = terminal.status;
        if (impact) await closeStepImpact(engine, impact, step, { jobId: job.id, status: terminal.status, doctorRunId });
        if (terminal.status !== 'completed') abortedIds.add(step.id);
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

      attemptedIds.add(step.id);
      recs.shift();
      // D7: scoped recheck — re-compute plan from fresh health snapshot.
      // Queue-level max_attempts handles retries within a submitted attempt.
      // A stuck health signal regenerates the same stable id, so keep ids this
      // run already attempted out of the refreshed list to avoid re-enqueueing
      // them forever.
      if (recs.length === 0 || stepCount >= maxJobs) break;
      const freshHealth = await engine.getHealth();
      // Extras carry a static status:'remediable' — a fresh health snapshot
      // never ages them out the way health-derived steps drop. Filter out
      // ids this run already processed (any terminal status), or the recheck
      // would resubmit completed extras every iteration, forever.
      const pendingExtras = extraRemediations.filter((r) => !attemptedIds.has(r.id));
      recs = computeRecommendations(freshHealth, ctx, pendingExtras)
        .filter((r) => r.status === 'remediable' && !attemptedIds.has(r.id) && (!manifest || manifest.job_ids.includes(r.id))
          && (!jobStepsSkipped || (r.est_usd_cost ?? 0) === 0));
    }
  };

  let budgetAbort: NonNullable<RemediationResult['budget_exhausted']> | undefined;
  try {
    try { await withBudgetTracker(repairTracker, runRepairs); }
    catch (err) { if (!(err instanceof BudgetExhausted)) throw err; }
    // Job estimates are rechecked against what the repairs left, including reserved effect estimates.
    const afterRepairs = remainingUsd();
    if (recs.length && afterRepairs !== undefined && (trackerExhausted || estJobUsd > afterRepairs)) {
      hooks.onBudgetRefused?.(estJobUsd, afterRepairs);
      jobsBudgetRefused = true;
      recs = [];
    }
    jobTracker = new BudgetTracker({ label: 'remediation.run', maxCostUsd: afterRepairs, capSource: opts.capSource });
    watch(jobTracker);
    await withBudgetTracker(jobTracker, runLoop);
  } catch (err) {
    if (err instanceof BudgetExhausted) {
      budgetAbort = exhaustionSnapshot;
    } else {
      throw err;
    }
  }
  // Tracker snapshots are per phase; report the operator's cumulative cap and settled spend.
  if (budgetAbort) budgetAbort = { ...budgetAbort, spent: settledUsd(), cap: maxUsd ?? budgetAbort.cap };
  // A paid repair step the cap refused (or that ran out mid-step) ends the
  // run as budget-exhausted even though the free steps completed.
  const refusedRepair = repairResults.find((r) => r.status === 'budget_refused' || r.status === 'budget_exhausted');
  if (!budgetAbort && (refusedRepair || jobsBudgetRefused)) {
    budgetAbort = { spent: settledUsd(), cap: maxUsd ?? 0, reason: 'max_usd', plan_hash: planHash };
    exhaustionSnapshot = budgetAbort;
    saveCheckpoint();
  }
  if (budgetAbort) hooks.onBudgetExhausted?.(planHash, budgetAbort);

  // Clear checkpoint on a clean run (no budget abort). Failed steps in the
  // submitted set don't disqualify cleanup; an uncleared health signal can
  // produce the same stable id again in a later run.
  if (!budgetAbort && pendingEmbedSources.length === 0) {
    clearRemediationCheckpoint(planHash);
  } else if (!budgetAbort) {
    // Re-sealed pages whose embeddings did not land stay resumable.
    saveCheckpoint();
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
    ...(jobStepsSkipped ? { job_steps_skipped: jobStepsSkipped } : {}),
    ...(repairs ? {
      repairs: repairResults, repairs_skipped: skippedRepairs,
      budget: { max_usd: maxUsd ?? null, spent_usd: settledUsd(), include_repairs: includeRepairs, plan_hash: planHash },
    } : {}),
    ...previewFailureField(previewFailures),
  };
}
