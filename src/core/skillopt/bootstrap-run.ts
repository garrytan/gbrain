/**
 * Guarded bootstrap runs (`--bootstrap-from-skill` / `--bootstrap-from-routing`).
 *
 * Bootstrap calls only the optimizer, so its models plan is one row. The
 * optimizer comes from `resolveSkillOptModels` like every other skillopt
 * path, prints its banner row, honors strict mode, and runs inside a
 * BudgetTracker bounded by `--max-cost-usd` (0 = uncapped), so a call whose
 * reservation cannot fit the cap is refused before it is made. `--dry-run`
 * previews the plan and strict verdict with no model call.
 */

import { withBudgetTracker, type chat as gatewayChat } from '../ai/gateway.ts';
import { BudgetTracker, loadPricingOverrides } from '../budget/budget-tracker.ts';
import type { BrainEngine } from '../engine.ts';
import { runBootstrap, runBootstrapFromSkill, type BootstrapResult } from './bootstrap-benchmark.ts';
import {
  formatModelsBanner,
  modelsStrictError,
  resolveModelsStrict,
  strictVerdict,
  type ModelResolution,
  type ModelsPlanEntry,
  type StrictVerdict,
} from './models-plan.ts';

export interface GuardedBootstrapOpts {
  engine: BrainEngine;
  mode: 'routing' | 'skill';
  skillsDir: string;
  skillName: string;
  optimizer: ModelResolution;
  /** Starter task count for `--bootstrap-from-skill`. */
  taskCount?: number;
  force?: boolean;
  dryRun: boolean;
  modelsStrict?: boolean;
  /** USD cap for the bootstrap calls; 0 = uncapped. */
  maxCostUsd: number;
  /** `user` (default) refuses an unpriced optimizer; `default` warns and runs it (#5563). */
  maxCostSource?: 'user' | 'default';
  /** Test seam — substitute gateway.chat. */
  chatFn?: typeof gatewayChat;
}

export type GuardedBootstrapResult =
  | { dry_run: true; models_plan: ModelsPlanEntry[]; strict: StrictVerdict }
  | { dry_run: false; models_plan: ModelsPlanEntry[]; strict: StrictVerdict; result: BootstrapResult; cost_usd: number };

export async function runGuardedBootstrap(opts: GuardedBootstrapOpts): Promise<GuardedBootstrapResult> {
  const plan: ModelsPlanEntry[] = [{ touchpoint: 'optimizer', ...opts.optimizer, active: true }];
  process.stderr.write(formatModelsBanner(plan, { skill: opts.skillName }));
  const strict = strictVerdict(plan, await resolveModelsStrict(opts.engine, opts.modelsStrict));
  if (opts.dryRun) return { dry_run: true, models_plan: plan, strict };
  if (strict.enabled && !strict.ok) throw modelsStrictError(strict);

  const pricingOverrides = await loadPricingOverrides(opts.engine);
  const tracker = new BudgetTracker({
    ...(opts.maxCostUsd > 0 ? { maxCostUsd: opts.maxCostUsd, capSource: opts.maxCostSource ?? 'user' } : {}),
    ...(pricingOverrides ? { pricingOverrides } : {}),
    label: `skillopt-bootstrap:${opts.skillName}`,
  });
  const common = {
    skillsDir: opts.skillsDir,
    skillName: opts.skillName,
    optimizerModel: opts.optimizer.model,
    force: opts.force,
    ...(opts.chatFn ? { chatFn: opts.chatFn } : {}),
  };
  const result = await withBudgetTracker(tracker, () => opts.mode === 'routing'
    ? runBootstrap(common)
    : runBootstrapFromSkill({ ...common, taskCount: opts.taskCount ?? 15 }));
  return { dry_run: false, models_plan: plan, strict, result, cost_usd: tracker.snapshot().cumulativeCostUsd };
}
