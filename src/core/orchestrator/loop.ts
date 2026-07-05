/**
 * orchestrator/loop.ts — the feedback-loop driver.
 *
 * Runs the orchestrator repeatedly: each round it ranks skills, executes the
 * NEWLY-recommended ones, feeds their outputs back into `priorSkillOutputs`, and
 * re-ranks with the new evidence — the loop in the Task 2 flowchart. It converges
 * because only *fresh* skills are executed each round, so once a round surfaces no
 * new skill the loop stops (`maxRounds` is a backstop, not the usual exit).
 *
 * Execution is INJECTED (`opts.executor`). With no executor the driver does a
 * single suggest-only pass — the safe default for a decision-support system where
 * auto-running clinical skills is a policy call, not an implementation default.
 */

import { runOrchestrator, type OrchestratorDeps } from './run.ts';
import type {
  OrchestratorContext,
  OrchestratorReport,
  SkillExecutor,
  SkillOutput,
} from './types.ts';

export interface LoopOptions {
  /** Runs a recommended skill and returns its output. Absent → single pass. */
  executor?: SkillExecutor;
  /** Backstop on rounds (default 3). Normal exit is convergence, not this. */
  maxRounds?: number;
  /** Execute only the top-N fresh recommendations each round (default: all). */
  topN?: number;
}

export interface LoopRound {
  round: number;
  report: OrchestratorReport;
  /** Outputs produced this round (empty on suggest-only / converged rounds). */
  executed: SkillOutput[];
}

export type LoopStop = 'stable' | 'empty' | 'max_rounds' | 'no_executor';

export interface LoopResult {
  rounds: LoopRound[];
  /** The last round's ranked report. */
  finalReport: OrchestratorReport;
  /** All skill outputs accumulated across rounds (seed + executed). */
  priorSkillOutputs: SkillOutput[];
  /** Why the loop stopped. */
  stopped: LoopStop;
}

export async function orchestrateLoop(
  ctx: OrchestratorContext,
  deps: OrchestratorDeps,
  opts: LoopOptions = {},
): Promise<LoopResult> {
  const maxRounds = Math.max(1, opts.maxRounds ?? 3);
  const rounds: LoopRound[] = [];
  const priorOutputs: SkillOutput[] = [...(ctx.priorSkillOutputs ?? [])];
  const everRecommended = new Set<string>();
  let stopped: LoopStop = 'max_rounds';
  let lastReport: OrchestratorReport | undefined;

  for (let round = 1; round <= maxRounds; round++) {
    const octx: OrchestratorContext = { ...ctx, priorSkillOutputs: priorOutputs.slice() };
    const report = await runOrchestrator(octx, deps);
    lastReport = report;

    // Nothing to run — converged on "no skills".
    if (report.recommendations.length === 0) {
      rounds.push({ round, report, executed: [] });
      stopped = 'empty';
      break;
    }

    const fresh = report.recommendations.filter((r) => !everRecommended.has(r.skill));
    for (const r of report.recommendations) everRecommended.add(r.skill);

    // Suggest-only: no executor wired.
    if (!opts.executor) {
      rounds.push({ round, report, executed: [] });
      stopped = 'no_executor';
      break;
    }

    // Converged: this round surfaced no NEW skill to run.
    if (fresh.length === 0) {
      rounds.push({ round, report, executed: [] });
      stopped = 'stable';
      break;
    }

    const toRun = typeof opts.topN === 'number' ? fresh.slice(0, opts.topN) : fresh;
    const executed: SkillOutput[] = [];
    for (const rec of toRun) {
      const out = await opts.executor(rec, octx);
      executed.push(out);
      priorOutputs.push(out);
    }
    rounds.push({ round, report, executed });
  }

  return {
    rounds,
    finalReport: lastReport as OrchestratorReport,
    priorSkillOutputs: priorOutputs,
    stopped,
  };
}
