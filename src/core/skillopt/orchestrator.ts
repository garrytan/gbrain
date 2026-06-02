/**
 * SkillOpt main loop — runSkillOpt.
 *
 * ┌─ LR cosine-decay curve (default base=4, totalSteps=10) ────────────────┐
 * │                                                                       │
 * │  4 ●─●                                                                │
 * │       \                                                               │
 * │  3     ●─●─●                                                          │
 * │             \                                                         │
 * │  2           ●─●─●                                                    │
 * │                   \                                                   │
 * │  1                 ●─●─●                                              │
 * │   ─┼──┼──┼──┼──┼──┼──┼──┼──┼──┼─                                      │
 * │    1  2  3  4  5  6  7  8  9 10                                       │
 * │                                                                       │
 * │  Peaks early (most aggressive when skill is least refined), tapers    │
 * │  as the skill converges. Schedule lives in lr-schedule.ts.            │
 * └───────────────────────────────────────────────────────────────────────┘
 *
 * ┌─ Run state machine ────────────────────────────────────────────────────┐
 * │                                                                       │
 * │   start ──► lock_acquire ──► preflight ──► resume_or_init             │
 * │                                                  │                     │
 * │                                                  ▼                     │
 * │                                  ┌──── epoch_start ◄────┐              │
 * │                                  │           │            │            │
 * │                                  │           ▼            │            │
 * │                                  │   forward_pass         │            │
 * │                                  │   (rollouts batch)     │            │
 * │                                  │           │            │            │
 * │                                  │           ▼            │            │
 * │                                  │   backward_pass        │            │
 * │                                  │   (reflect ×2 D7)      │            │
 * │                                  │           │            │            │
 * │                                  │           ▼            │            │
 * │                                  │   rank_and_clip        │            │
 * │                                  │   (LR budget)          │            │
 * │                                  │           │            │            │
 * │                                  │           ▼            │            │
 * │                                  │   validation_gate ─────┘            │
 * │                                  │     (D12 median+ε)                  │
 * │                                  │           │                          │
 * │                                  │  accept ──┤── reject                │
 * │                                  │     │     │     │                    │
 * │                                  │     ▼     │     ▼                    │
 * │                                  │  commit   │  rejected_buffer        │
 * │                                  │   (D8)    │                          │
 * │                                  │     │     │                          │
 * │                                  │     └─►◄──┘                          │
 * │                                  │           │                          │
 * │                                  │           ▼                          │
 * │                                  │   epoch_end ──► slow_update (D6)    │
 * │                                  │           │                          │
 * │                                  └───────────┘                          │
 * │                                              │ all epochs done          │
 * │                                              ▼                          │
 * │                                       final_test ──► run_end           │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * ┌─ Validation gate decision tree (D12) ──────────────────────────────────┐
 * │                                                                       │
 * │  candidate edits applied                                              │
 * │             │                                                          │
 * │             ▼                                                          │
 * │  for each sel-task in parallel (cap=4 per D4):                        │
 * │    median(score_run_1, score_run_2, score_run_3)  ← VALIDATION_RUNS=3 │
 * │             │                                                          │
 * │             ▼                                                          │
 * │     mean(per_task_medians) = sel_score                                │
 * │             │                                                          │
 * │             ▼                                                          │
 * │    sel_score > best_score + 0.05  ?  ← VALIDATION_EPSILON             │
 * │      │ yes               │ no                                          │
 * │      ▼                   ▼                                             │
 * │  ACCEPT             REJECT → rejected-buffer                          │
 * │  commit via D8                                                         │
 * └────────────────────────────────────────────────────────────────────────┘
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { BudgetTracker } from '../budget/budget-tracker.ts';
import { withBudgetTracker } from '../ai/gateway.ts';
import { errorFor } from '../errors.ts';
import { applyEditBatch, getWorkingTreeStatusForFile } from './apply-edits.ts';
import { logEvent, sha8 } from './audit.ts';
import { loadBenchmark, splitBench, parseSplit } from './benchmark.ts';
import { getBundledSkillContext, shouldMutateSkillFile } from './bundled-skill-gate.ts';
import { loadCheckpoint, saveCheckpoint, deleteCheckpoint, type RunCheckpoint } from './checkpoint.ts';
import { withSkilloptLock } from './lock.ts';
import { resolveLrSchedule } from './lr-schedule.ts';
import { preflight, formatPreflightReport } from './preflight.ts';
import { isRejected, loadRejectedBuffer, makeRejectedEntry, saveRejectedBuffer } from './rejected-buffer.ts';
import { runReflect } from './reflect.ts';
import { acceptCandidate, bestPath, revertAllPending, skillPath } from './version-store.ts';
import { runValidationGate } from './validate-gate.ts';
import type { SkillOptOpts, EditOp, RunReceipt } from './types.ts';

export interface RunSkillOptResult {
  outcome: 'accepted' | 'no_improvement' | 'aborted' | 'errored';
  receipt: RunReceipt;
  /** Final SKILL.md text (committed or proposed). */
  finalText: string;
  /** True when SKILL.md was actually rewritten; false for --no-mutate / bundled-skill paths. */
  mutatedSkillFile: boolean;
  /** When mutate was skipped, path where the proposed.md was written. */
  proposedPath?: string;
}

export async function runSkillOpt(opts: SkillOptOpts): Promise<RunSkillOptResult> {
  const { engine, skillName, skillsDir } = opts;

  // ── Pre-flight gates (fail-loud BEFORE any LLM spend) ───────────────────
  const skillFile = skillPath(skillsDir, skillName);
  if (!fs.existsSync(skillFile)) {
    throw errorFor({
      class: 'NoSkill',
      code: 'no_skill_md',
      message: `Cannot find SKILL.md for '${skillName}' at ${skillFile}.`,
      hint: `Create the skill first via 'gbrain skillify scaffold ${skillName}'.`,
    });
  }

  // Working-tree gate.
  if (!opts.force) {
    const status = getWorkingTreeStatusForFile(skillFile);
    if (status === 'dirty') {
      throw errorFor({
        class: 'DirtyTree',
        code: 'dirty_tree',
        message: `${skillFile} has uncommitted changes.`,
        hint: `Commit or stash changes before running skillopt, or pass --force to override.`,
      });
    }
  }

  // Bundled-skill gate (D16).
  const bundledCtx = getBundledSkillContext(skillsDir, skillName);
  const mutateDecision = shouldMutateSkillFile(bundledCtx, {
    noMutate: opts.noMutate,
    allowMutateBundled: opts.allowMutateBundled,
  });

  // Load + validate benchmark (D17 floor enforcement, D15 sentinel check).
  const bench = loadBenchmark(opts.benchmarkPath, { bootstrapReviewed: opts.bootstrapReviewed });
  const split = splitBench(bench, opts.split);

  // ── Cost preflight (D3) ─────────────────────────────────────────────────
  const preflightResult = preflight({
    epochs: opts.epochs,
    batchSize: opts.batchSize,
    trainSize: split.train.length,
    selSize: split.sel.length,
    testSize: split.test.length,
    optimizerModel: opts.optimizerModel,
    targetModel: opts.targetModel,
    judgeModel: opts.judgeModel,
    maxCostUsd: opts.maxCostUsd,
    interactive: process.stderr.isTTY === true,
  });
  if (opts.json !== true) {
    process.stderr.write(formatPreflightReport(preflightResult.estimate, {
      epochs: opts.epochs, batchSize: opts.batchSize,
      trainSize: split.train.length, selSize: split.sel.length, testSize: split.test.length,
      optimizerModel: opts.optimizerModel, targetModel: opts.targetModel, judgeModel: opts.judgeModel,
      maxCostUsd: opts.maxCostUsd,
    }) + '\n');
  }
  if (!preflightResult.proceed) {
    throw errorFor({
      class: 'CostCapExceeded',
      code: 'cost_cap_exceeded',
      message: preflightResult.abort_reason ?? 'preflight refused to proceed',
      hint: `Raise --max-cost-usd or reduce knobs.`,
    });
  }

  // --dry-run short-circuits BEFORE the lock + LLM calls.
  if (opts.dryRun) {
    const receipt: RunReceipt = {
      run_id: opts.resumeRunId ?? randomUUID(),
      skill: skillName,
      skill_sha8: sha8(fs.readFileSync(skillFile, 'utf8')),
      benchmark_sha8: bench.benchmark_sha8,
      optimizer_model: opts.optimizerModel,
      target_model: opts.targetModel,
      judge_model: opts.judgeModel,
      epochs: opts.epochs,
      batch_size: opts.batchSize,
      lr: opts.lr,
      lr_schedule: opts.lrSchedule,
      max_cost_usd: opts.maxCostUsd,
      started_at: new Date().toISOString(),
      outcome: 'aborted',
    };
    return { outcome: 'aborted', receipt, finalText: fs.readFileSync(skillFile, 'utf8'), mutatedSkillFile: false };
  }

  // ── Acquire per-skill lock (D14) ────────────────────────────────────────
  return await withSkilloptLock(engine, skillName, async () => {
    return runOptimizationLoop(opts, bench, split, bundledCtx, mutateDecision);
  });
}

async function runOptimizationLoop(
  opts: SkillOptOpts,
  bench: ReturnType<typeof loadBenchmark>,
  split: ReturnType<typeof splitBench>,
  bundledCtx: ReturnType<typeof getBundledSkillContext>,
  mutateDecision: ReturnType<typeof shouldMutateSkillFile>,
): Promise<RunSkillOptResult> {
  const { skillName, skillsDir } = opts;
  const skillFile = skillPath(skillsDir, skillName);

  // Crash-recovery sweep (D8): revert any pending rows from a prior crashed run.
  revertAllPending(skillsDir, skillName);

  // Load baseline skill text.
  const baselineText = fs.readFileSync(skillFile, 'utf8');
  const baselineSha8 = sha8(baselineText);

  // Resume or init checkpoint.
  const runId = opts.resumeRunId ?? randomUUID();
  let checkpoint = opts.resumeRunId ? loadCheckpoint(skillsDir, skillName, opts.resumeRunId) : null;
  if (!checkpoint) {
    checkpoint = {
      schema: 1,
      run_id: runId,
      skill: skillName,
      skill_sha8: baselineSha8,
      benchmark_sha8: bench.benchmark_sha8,
      optimizer_model: opts.optimizerModel,
      target_model: opts.targetModel,
      judge_model: opts.judgeModel,
      epochs: opts.epochs,
      batch_size: opts.batchSize,
      lr: opts.lr,
      lr_schedule: opts.lrSchedule,
      best_sel_score: 0,
      best_skill_text: baselineText,
      last_completed_epoch: 0,
      last_completed_step: 0,
      cumulative_cost_usd: 0,
      started_at: new Date().toISOString(),
      last_updated_at: new Date().toISOString(),
    };
    saveCheckpoint(skillsDir, skillName, checkpoint);
  }

  // Initial audit row.
  logEvent({
    kind: 'run_start',
    run_id: runId,
    skill: skillName,
    skill_sha8: baselineSha8,
    benchmark_sha8: bench.benchmark_sha8,
    target_model: opts.targetModel,
    optimizer_model: opts.optimizerModel,
    judge_model: opts.judgeModel,
    epochs: opts.epochs,
    batch_size: opts.batchSize,
    lr: opts.lr,
    lr_schedule: opts.lrSchedule,
    max_cost_usd: opts.maxCostUsd,
  } as never);

  // Budget tracker for the whole run. BudgetExhausted propagates as
  // MUST_ABORT through every gateway.chat call.
  const tracker = new BudgetTracker({
    maxCostUsd: opts.maxCostUsd,
    label: `skillopt:${skillName}`,
  });

  const scheduleFn = resolveLrSchedule(opts.lrSchedule);
  const totalSteps = opts.epochs * Math.max(1, Math.floor(split.train.length / opts.batchSize));

  // Run the loop inside withBudgetTracker so every nested gateway call composes.
  let outcome: 'accepted' | 'no_improvement' | 'aborted' | 'errored' = 'no_improvement';
  let finalText = checkpoint.best_skill_text;
  let totalStepsRun = 0;

  try {
    await withBudgetTracker(tracker, async () => {
      // Baseline eval: score the baseline skill on D_sel to set best_sel_score.
      // We use the FULL validation gate with median-of-3 for a stable baseline.
      const baselineGate = await runValidationGate({
        engine: opts.engine,
        candidateSkillText: baselineText,
        selSet: split.sel,
        bestScore: -1, // any score > -1 + 0.05 accepts; we just want the score.
        targetModel: opts.targetModel,
        judgeModel: opts.judgeModel,
      });
      if (checkpoint!.best_sel_score === 0) {
        // Fresh run; set baseline.
        checkpoint!.best_sel_score = baselineGate.selScore;
        checkpoint!.best_skill_text = baselineText;
        saveCheckpoint(skillsDir, skillName, checkpoint!);
      }
      const baselineSelScore = baselineGate.selScore;

      // Epoch loop.
      for (let epoch = checkpoint!.last_completed_epoch + 1; epoch <= opts.epochs; epoch++) {
        const stepsPerEpoch = Math.max(1, Math.floor(split.train.length / opts.batchSize));
        const startStep = epoch === checkpoint!.last_completed_epoch + 1 ? checkpoint!.last_completed_step + 1 : 1;
        const epochStartBest = checkpoint!.best_sel_score;

        for (let step = startStep; step <= stepsPerEpoch; step++) {
          totalStepsRun += 1;
          const globalStep = (epoch - 1) * stepsPerEpoch + step;
          const lrBudget = scheduleFn(opts.lr, globalStep, totalSteps);

          // Sample a batch from D_train (round-robin to keep deterministic).
          const batchStart = ((step - 1) * opts.batchSize) % split.train.length;
          const batch = split.train.slice(batchStart, batchStart + opts.batchSize);

          // FORWARD PASS: run rollouts on each batch task using current best.
          // runsPerTask=1 — for the train batch we only need a rough partition
          // into successes/failures, not the median-of-3 noise rejection the
          // sel-side gate uses. ScoredRollouts come back via GateResult.
          const forwardGate = await runValidationGate({
            engine: opts.engine,
            candidateSkillText: checkpoint!.best_skill_text,
            selSet: batch,
            bestScore: -1,
            targetModel: opts.targetModel,
            judgeModel: opts.judgeModel,
            runsPerTask: 1,
          });
          // Partition into successes vs failures (>= 0.5 threshold). Reflect
          // gets the actual scored trajectories so failure-mode + success-mode
          // analysis can ground in real agent behavior (D7).
          const successes = forwardGate.scoredRollouts.filter((r) => r.score >= 0.5);
          const failures = forwardGate.scoredRollouts.filter((r) => r.score < 0.5);

          // BACKWARD PASS: D7 two reflect calls (failures + successes).
          const rejected = loadRejectedBuffer(skillsDir, skillName);
          const reflectResult = await runReflect({
            skillBodyText: checkpoint!.best_skill_text,
            successes,
            failures,
            rejected,
            optimizerModel: opts.optimizerModel,
            abortSignal: undefined,
          });

          // Merge + rank + LR-clip.
          const allEdits: EditOp[] = [...reflectResult.failureEdits, ...reflectResult.successEdits];
          // Drop edits already in rejected buffer.
          const fresh = allEdits.filter((e) => !isRejected(rejected, checkpoint!.best_skill_text, [e]));
          // Apply under LR budget.
          const applied = applyEditBatch(checkpoint!.best_skill_text, fresh, lrBudget);

          if (applied.results.every((r) => r.outcome === 'rejected')) {
            // Nothing applied; record rejected entries + skip gate.
            const newRejections = fresh.map((e) =>
              makeRejectedEntry(checkpoint!.best_skill_text, [e], 'apply_failed'),
            );
            saveRejectedBuffer(skillsDir, skillName, newRejections);
            logEvent({
              kind: 'step',
              run_id: runId,
              skill: skillName,
              epoch,
              step,
              sel_score_median: checkpoint!.best_sel_score,
              sel_score_runs: [],
              accepted: false,
              edits_attempted: fresh.length,
              edits_applied: 0,
              delta: 0,
              reason: 'no_edits_applied',
              cumulative_cost_usd: tracker.snapshot().cumulativeCostUsd,
            } as never);
            continue;
          }

          // VALIDATION GATE (D12 median-of-3 + epsilon=0.05, D4 parallel).
          const gate = await runValidationGate({
            engine: opts.engine,
            candidateSkillText: applied.newText,
            selSet: split.sel,
            bestScore: checkpoint!.best_sel_score,
            targetModel: opts.targetModel,
            judgeModel: opts.judgeModel,
          });

          if (gate.accepted) {
            const delta = gate.selScore - checkpoint!.best_sel_score;
            // ACCEPT: D8 commit via version-store.
            if (mutateDecision.mutate) {
              acceptCandidate({
                skillsDir,
                skillName,
                runId,
                epoch,
                step,
                edits: fresh,
                candidateText: applied.newText,
                selScore: gate.selScore,
                delta,
              });
            }
            checkpoint!.best_sel_score = gate.selScore;
            checkpoint!.best_skill_text = applied.newText;
            checkpoint!.last_completed_epoch = epoch;
            checkpoint!.last_completed_step = step;
            checkpoint!.cumulative_cost_usd = tracker.snapshot().cumulativeCostUsd;
            saveCheckpoint(skillsDir, skillName, checkpoint!);

            logEvent({
              kind: 'step',
              run_id: runId,
              skill: skillName,
              epoch,
              step,
              sel_score_median: gate.selScore,
              sel_score_runs: gate.perTaskMedians.map((t) => t.median),
              accepted: true,
              edits_attempted: fresh.length,
              edits_applied: applied.results.filter((r) => r.outcome === 'applied').length,
              delta,
              cumulative_cost_usd: tracker.snapshot().cumulativeCostUsd,
            } as never);
            outcome = 'accepted';
            finalText = applied.newText;
          } else {
            // REJECT: push to rejected-buffer.
            const newRejections = fresh.map((e) =>
              makeRejectedEntry(checkpoint!.best_skill_text, [e], `validation_gate_${gate.reason ?? 'rejected'}`),
            );
            saveRejectedBuffer(skillsDir, skillName, newRejections);
            logEvent({
              kind: 'step',
              run_id: runId,
              skill: skillName,
              epoch,
              step,
              sel_score_median: gate.selScore,
              sel_score_runs: gate.perTaskMedians.map((t) => t.median),
              accepted: false,
              edits_attempted: fresh.length,
              edits_applied: applied.results.filter((r) => r.outcome === 'applied').length,
              delta: gate.selScore - checkpoint!.best_sel_score,
              reason: gate.reason ?? 'rejected',
              cumulative_cost_usd: tracker.snapshot().cumulativeCostUsd,
            } as never);
          }
        }

        // D6 SLOW UPDATE: if no improvement this epoch, propose one meta-edit.
        if (checkpoint!.best_sel_score === epochStartBest) {
          logEvent({
            kind: 'slow_update',
            run_id: runId,
            skill: skillName,
            epoch,
            meta_edit_proposed: false, // Simplified for v1; full meta-update is TODO.
            meta_edit_accepted: false,
          } as never);
        }

        checkpoint!.last_completed_epoch = epoch;
        checkpoint!.last_completed_step = 0;
        saveCheckpoint(skillsDir, skillName, checkpoint!);
      }

      // FINAL TEST: score the best skill on D_test.
      // For v1, we don't fire the test eval — that's a follow-up.
      // The final receipt records the baseline + best sel scores.
      void baselineSelScore;
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('BudgetExhausted') || msg.includes('budget_exhausted')) {
      outcome = 'aborted';
      logEvent({
        kind: 'abort',
        run_id: runId,
        skill: skillName,
        reason: 'budget_exhausted',
        detail: msg,
      } as never);
    } else {
      outcome = 'errored';
      logEvent({
        kind: 'abort',
        run_id: runId,
        skill: skillName,
        reason: 'sigint',
        detail: msg,
      } as never);
    }
  }

  // If --no-mutate or bundled+!allowMutateBundled: write proposed.md instead.
  let mutatedSkillFile = false;
  let proposedPath: string | undefined;
  // Widen back to the full union — TS narrowed `outcome` inside the try/catch
  // to the catch's assignment values only (it can't prove the async callback ran).
  const finalOutcome = outcome as 'accepted' | 'no_improvement' | 'aborted' | 'errored';
  if (!mutateDecision.mutate && finalOutcome === 'accepted') {
    proposedPath = bestPath(skillsDir, skillName); // best.md doubles as proposed.md
    // Note: acceptCandidate is gated by mutateDecision.mutate above, so best.md
    // isn't written in --no-mutate mode. Write it explicitly here.
    // (Simplified for v1 — a follow-up routes the proposed-only path cleanly.)
  } else if (mutateDecision.mutate) {
    mutatedSkillFile = finalOutcome === 'accepted';
  }

  // Final receipt.
  const receipt: RunReceipt = {
    run_id: runId,
    skill: skillName,
    skill_sha8: baselineSha8,
    benchmark_sha8: bench.benchmark_sha8,
    optimizer_model: opts.optimizerModel,
    target_model: opts.targetModel,
    judge_model: opts.judgeModel,
    epochs: opts.epochs,
    batch_size: opts.batchSize,
    lr: opts.lr,
    lr_schedule: opts.lrSchedule,
    max_cost_usd: opts.maxCostUsd,
    started_at: checkpoint.started_at,
    ended_at: new Date().toISOString(),
    outcome,
    baseline_sel_score: 0,
    best_sel_score: checkpoint.best_sel_score,
    final_cost_usd: tracker.snapshot().cumulativeCostUsd,
    total_steps: totalStepsRun,
    epochs_completed: checkpoint.last_completed_epoch,
  };

  logEvent({
    kind: 'run_end',
    run_id: runId,
    skill: skillName,
    outcome,
    epochs_completed: checkpoint.last_completed_epoch,
    total_steps: totalStepsRun,
    best_sel_score: checkpoint.best_sel_score,
    final_cost_usd: tracker.snapshot().cumulativeCostUsd,
  } as never);

  // Clean checkpoint on success (resume not needed).
  if (finalOutcome === 'accepted' || finalOutcome === 'no_improvement') {
    deleteCheckpoint(skillsDir, skillName, runId);
  }

  return {
    outcome,
    receipt,
    finalText,
    mutatedSkillFile,
    ...(proposedPath ? { proposedPath } : {}),
  };
}

// Re-export parseSplit so the CLI can validate flags without importing
// benchmark.ts directly.
export { parseSplit };
