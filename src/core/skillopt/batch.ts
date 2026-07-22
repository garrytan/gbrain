/**
 * SkillOpt `--all` cross-skill batch mode + `--target-model multi`
 * cross-model fleet (F4 + F5).
 *
 * `--all`: walk every skill under skillsDir that has skillopt-benchmark.jsonl
 * and run optimization sequentially with a brain-wide BudgetTracker. Same
 * shape as the dream-cycle phase wrapper but driven by the CLI flag.
 *
 * `--target-model multi`: instead of optimizing for a single target model,
 * optimize ONCE and capture per-model receipts so the user can pick the
 * best skill-per-model. Implemented as N parallel runSkillOpt invocations
 * (one per model) with shared optimizer + judge models but different
 * target-models.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { runSkillOpt } from './orchestrator.ts';
import type { RunReceipt, SkillOptOpts } from './types.ts';

export interface BatchAllOpts {
  engine: BrainEngine;
  skillsDir: string;
  /** Per-skill budget (each skill gets its own tracker). */
  perSkillMaxCostUsd: number;
  /** Brain-wide cumulative ceiling. */
  brainWideMaxCostUsd: number;
  /** Common knobs threaded to each skill. */
  optimizerModel: string;
  targetModel: string;
  judgeModel: string;
  epochs: number;
  batchSize: number;
  lr: number;
  lrSchedule: 'cosine' | 'linear' | 'constant';
  split: [number, number, number];
  dryRun: boolean;
  noMutate: boolean;
  allowMutateBundled: boolean;
  force: boolean;
  /** Optional filter — only run skills whose name passes this predicate. */
  filter?: (skillName: string) => boolean;
}

export interface BatchAllResult {
  skills_scanned: number;
  skills_run: number;
  accepted: number;
  no_improvement: number;
  errored: number;
  brain_wide_cap_reached: boolean;
  cumulative_cost_usd: number;
  per_skill: Array<{
    skill: string;
    outcome: 'accepted' | 'no_improvement' | 'aborted' | 'errored' | 'skipped_cap';
    cost_usd: number;
    receipt?: RunReceipt;
    reason?: string;
  }>;
}

export async function runBatchAll(opts: BatchAllOpts): Promise<BatchAllResult> {
  const skills = collectSkillsWithBenchmarks(opts.skillsDir).filter(
    (s) => !opts.filter || opts.filter(s),
  );
  const out: BatchAllResult = {
    skills_scanned: skills.length,
    skills_run: 0,
    accepted: 0,
    no_improvement: 0,
    errored: 0,
    brain_wide_cap_reached: false,
    cumulative_cost_usd: 0,
    per_skill: [],
  };

  for (const skillName of skills) {
    if (out.cumulative_cost_usd >= opts.brainWideMaxCostUsd) {
      out.brain_wide_cap_reached = true;
      out.per_skill.push({ skill: skillName, outcome: 'skipped_cap', cost_usd: 0, reason: 'brain_wide_cap_reached' });
      continue;
    }
    const remaining = opts.brainWideMaxCostUsd - out.cumulative_cost_usd;
    const cap = Math.min(opts.perSkillMaxCostUsd, remaining);
    const benchmarkPath = path.join(opts.skillsDir, skillName, 'skillopt-benchmark.jsonl');

    const skillOptOpts: SkillOptOpts = {
      engine: opts.engine,
      skillName,
      skillsDir: opts.skillsDir,
      benchmarkPath,
      epochs: opts.epochs,
      batchSize: opts.batchSize,
      lr: opts.lr,
      lrSchedule: opts.lrSchedule,
      split: opts.split,
      optimizerModel: opts.optimizerModel,
      targetModel: opts.targetModel,
      judgeModel: opts.judgeModel,
      mode: 'patch',
      dryRun: opts.dryRun,
      noMutate: opts.noMutate,
      allowMutateBundled: opts.allowMutateBundled,
      bootstrapReviewed: false,
      json: true,
      maxCostUsd: cap,
      maxRuntimeMin: 30,
      force: opts.force,
    };

    try {
      const result = await runSkillOpt(skillOptOpts);
      const spent = result.receipt.final_cost_usd ?? 0;
      out.cumulative_cost_usd += spent;
      out.skills_run += 1;
      if (result.outcome === 'accepted') out.accepted += 1;
      else if (result.outcome === 'no_improvement') out.no_improvement += 1;
      else if (result.outcome === 'errored') out.errored += 1;
      out.per_skill.push({
        skill: skillName,
        outcome: result.outcome as never,
        cost_usd: spent,
        receipt: result.receipt,
      });
    } catch (err) {
      out.errored += 1;
      const msg = err instanceof Error ? err.message : String(err);
      out.per_skill.push({ skill: skillName, outcome: 'errored', cost_usd: 0, reason: msg });
    }
  }

  return out;
}

export interface FleetOpts {
  /** Same shape as SkillOptOpts but with N target models instead of 1. */
  engine: BrainEngine;
  skillName: string;
  skillsDir: string;
  benchmarkPath: string;
  targetModels: string[];
  optimizerModel: string;
  judgeModel: string;
  epochs: number;
  batchSize: number;
  lr: number;
  lrSchedule: 'cosine' | 'linear' | 'constant';
  split: [number, number, number];
  dryRun: boolean;
  noMutate: boolean;
  allowMutateBundled: boolean;
  bootstrapReviewed: boolean;
  /** F11: optional held-out test set (one skill, so a single path is valid here). */
  heldOutPath?: string;
  maxCostUsd: number;
  maxRuntimeMin: number;
  force: boolean;
}

export interface FleetResult {
  skill: string;
  per_model: Array<{
    target_model: string;
    outcome: 'accepted' | 'no_improvement' | 'aborted' | 'errored';
    best_sel_score: number;
    final_cost_usd: number;
    receipt: RunReceipt;
  }>;
  best_model?: string;
  best_score?: number;
}

/**
 * Run N parallel SkillOpt invocations against the same skill with
 * different target models. Per-target-model receipts so the operator can
 * see which model the skill optimized best against.
 *
 * IMPORTANT: when targetModels.length > 1 AND noMutate is false, the
 * orchestrator's per-skill DB lock would serialize them anyway. We
 * force `noMutate: true` for fleet runs — the operator picks a winner
 * by inspecting the per-model receipts + best.md from each subdir.
 *
 * Each per-target invocation writes its outputs under
 * `skills/<name>/skillopt/fleet/<model-slug>/` instead of the canonical
 * `skills/<name>/skillopt/` path, so the receipts don't clobber each other.
 */
export async function runFleet(opts: FleetOpts): Promise<FleetResult> {
  if (opts.targetModels.length === 0) {
    throw new Error('runFleet: targetModels must be non-empty');
  }

  // Fleet runs are ALWAYS no-mutate. The operator must explicitly pick
  // a winner and copy its best.md to SKILL.md.
  const noMutate = true;

  const promises = opts.targetModels.map(async (targetModel) => {
    const slug = slugifyModel(targetModel);
    // Use a per-model subdirectory by pointing skillsDir at a synthesized
    // path that includes the slug. Mkdir the path so apply-edits + version-
    // store work inside it. Copy the SKILL.md into the per-model dir
    // up-front so each fleet run sees the same baseline.
    const fleetDir = path.join(opts.skillsDir, opts.skillName, 'skillopt', 'fleet', slug);
    fs.mkdirSync(fleetDir, { recursive: true });
    // Per-model "skills dir" sees only this one skill.
    const perModelSkillsDir = path.join(opts.skillsDir, opts.skillName, 'skillopt', 'fleet', slug, 'staging');
    fs.mkdirSync(path.join(perModelSkillsDir, opts.skillName), { recursive: true });
    const stagingSkillPath = path.join(perModelSkillsDir, opts.skillName, 'SKILL.md');
    const baselinePath = path.join(opts.skillsDir, opts.skillName, 'SKILL.md');
    fs.copyFileSync(baselinePath, stagingSkillPath);

    const skillOptOpts: SkillOptOpts = {
      engine: opts.engine,
      skillName: opts.skillName,
      skillsDir: perModelSkillsDir,
      benchmarkPath: opts.benchmarkPath,
      epochs: opts.epochs,
      batchSize: opts.batchSize,
      lr: opts.lr,
      lrSchedule: opts.lrSchedule,
      split: opts.split,
      optimizerModel: opts.optimizerModel,
      targetModel,
      judgeModel: opts.judgeModel,
      mode: 'patch',
      dryRun: opts.dryRun,
      noMutate,
      allowMutateBundled: opts.allowMutateBundled,
      bootstrapReviewed: opts.bootstrapReviewed,
      ...(opts.heldOutPath ? { heldOutPath: opts.heldOutPath } : {}),
      json: true,
      maxCostUsd: opts.maxCostUsd,
      maxRuntimeMin: opts.maxRuntimeMin,
      force: opts.force,
    };
    const result = await runSkillOpt(skillOptOpts);
    return {
      target_model: targetModel,
      outcome: result.outcome as 'accepted' | 'no_improvement' | 'aborted' | 'errored',
      best_sel_score: result.receipt.best_sel_score ?? 0,
      final_cost_usd: result.receipt.final_cost_usd ?? 0,
      receipt: result.receipt,
    };
  });

  const settled = await Promise.allSettled(promises);
  const per_model = settled.map((s, i) => {
    if (s.status === 'fulfilled') return s.value;
    return {
      target_model: opts.targetModels[i]!,
      outcome: 'errored' as const,
      best_sel_score: 0,
      final_cost_usd: 0,
      receipt: {} as RunReceipt,
    };
  });

  const result: FleetResult = { skill: opts.skillName, per_model };

  // Pick the best-scoring model.
  const winning = per_model.reduce<{ model: string; score: number } | null>((acc, p) => {
    if (p.outcome !== 'accepted' && p.outcome !== 'no_improvement') return acc;
    if (acc === null || p.best_sel_score > acc.score) {
      return { model: p.target_model, score: p.best_sel_score };
    }
    return acc;
  }, null);
  if (winning) {
    result.best_model = winning.model;
    result.best_score = winning.score;
  }

  return result;
}

function slugifyModel(model: string): string {
  return model.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
}

function collectSkillsWithBenchmarks(skillsDir: string): string[] {
  if (!fs.existsSync(skillsDir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(skillsDir)) {
    const dir = path.join(skillsDir, entry);
    let isDir = false;
    try { isDir = fs.statSync(dir).isDirectory(); } catch { /* skip */ }
    if (!isDir) continue;
    const benchPath = path.join(dir, 'skillopt-benchmark.jsonl');
    if (fs.existsSync(benchPath)) out.push(entry);
  }
  return out.sort();
}
