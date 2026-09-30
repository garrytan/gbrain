/**
 * `gbrain skillopt <skill> [flags]` CLI dispatcher.
 *
 * Top-level command (not under `gbrain eval`) because it MUTATES files.
 * See: src/core/skillopt/ for the implementation modules.
 */

import * as path from 'node:path';
import { autoDetectSkillsDirReadOnly } from '../core/repo-root.ts';
import { runGuardedBootstrap } from '../core/skillopt/bootstrap-run.ts';
import { buildSkillOptJobData } from '../core/skillopt/job.ts';
import {
  buildModelsPlan,
  describeStrictVerdict,
  formatModelsBanner,
  resolveSkillOptModels,
  skillOptModelOpts,
  type ModelsPlanEntry,
  type StrictVerdict,
} from '../core/skillopt/models-plan.ts';
import { SKILLOPT_HELP_TEXT } from '../core/skillopt/help.ts';
import { runSkillOpt, parseSplit } from '../core/skillopt/orchestrator.ts';
import { checkpointPath } from '../core/skillopt/checkpoint.ts';
import { formatModelsUsedTable } from '../core/budget/models-used.ts';
import { parsePositiveInt } from '../core/skillopt/output-cap.ts';
import { serializeError, StructuredAgentError } from '../core/errors.ts';
import type { BrainEngine } from '../core/engine.ts';
import type { RunReceipt, SkillOptOpts } from '../core/skillopt/types.ts';

interface ParsedFlags {
  skillName: string;
  benchmarkPath?: string;
  bootstrapFromRouting: boolean;
  bootstrapFromSkill: boolean;
  /** Number of starter tasks for --bootstrap-from-skill (default 15, cap 50). */
  bootstrapTasks?: number;
  bootstrapReviewed: boolean;
  epochs: number;
  batchSize: number;
  lr: number;
  lrSchedule: 'cosine' | 'linear' | 'constant';
  split: [number, number, number];
  optimizerModel?: string;
  targetModel?: string;
  judgeModel?: string;
  /** Optimizer output cap; beats skillopt.reflect_max_tokens config. */
  reflectMaxTokens?: number;
  /** Abort before spend unless every active model was chosen by explicit configuration. */
  modelsStrict: boolean;
  mode: 'patch' | 'rewrite';
  dryRun: boolean;
  noMutate: boolean;
  allowMutateBundled: boolean;
  /** F11: optional held-out test set path. REQUIRED (non-empty) to mutate a bundled skill. */
  heldOutPath?: string;
  json: boolean;
  maxCostUsd: number;
  maxRuntimeMin: number;
  force: boolean;
  resumeRunId?: string;
  skillsDir?: string;
  help: boolean;
  /** F4: optimize every skill under skillsDir with a benchmark. */
  all: boolean;
  /** F4: brain-wide cost cap for --all (per-skill cap stays --max-cost-usd). */
  brainWideMaxCostUsd?: number;
  /** F5: comma-separated list of target models for fleet mode. */
  targetModelsFleet?: string[];
}

export async function runSkillOptCommand(engine: BrainEngine | null, args: string[]): Promise<void> {
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    process.stdout.write(SKILLOPT_HELP_TEXT);
    process.exit(0);
  }

  let parsed: ParsedFlags;
  try {
    parsed = parseFlags(args);
  } catch (err) {
    process.stderr.write(`gbrain skillopt: ${err instanceof Error ? err.message : String(err)}\n\n`);
    process.stderr.write(SKILLOPT_HELP_TEXT);
    process.exit(2);
  }

  if (parsed.help) {
    process.stdout.write(SKILLOPT_HELP_TEXT);
    process.exit(0);
  }

  if (!engine) {
    process.stderr.write('gbrain skillopt: requires a configured brain (engine connection failed)\n');
    process.exit(2);
  }

  // Resolve skills dir.
  const detected = autoDetectSkillsDirReadOnly(process.cwd());
  const skillsDir = parsed.skillsDir ?? detected.dir;
  if (!skillsDir) {
    process.stderr.write(`gbrain skillopt: cannot find skills directory. Pass --skills-dir <path> or run from a workspace with a skills/ directory.\n`);
    process.exit(2);
  }

  // Resolve the three roles once (flag > role config chain), with provenance.
  const modelFlags = { optimizerModel: parsed.optimizerModel, targetModel: parsed.targetModel, judgeModel: parsed.judgeModel };
  const models = await resolveSkillOptModels(engine, modelFlags);
  const { optimizerModel, targetModel, judgeModel } = skillOptModelOpts(models);

  // ── Bootstrap modes (short-circuit before the optimization loop) ────────
  // --bootstrap-from-skill reads SKILL.md directly (no routing-eval needed)
  // and emits a full starter benchmark; --bootstrap-from-routing makes one
  // call per routing intent. Both write the D15 sentinel, run under the
  // --max-cost-usd tracker and honor --models-strict / --dry-run. Provider
  // errors propagate so the user sees the real failure instead of "0 tasks".
  if (parsed.bootstrapFromRouting || parsed.bootstrapFromSkill) {
    try {
      const run = await runGuardedBootstrap({
        engine,
        mode: parsed.bootstrapFromRouting ? 'routing' : 'skill',
        skillsDir,
        skillName: parsed.skillName,
        optimizer: models.optimizer,
        taskCount: parsed.bootstrapTasks ?? 15,
        force: parsed.force,
        dryRun: parsed.dryRun,
        modelsStrict: parsed.modelsStrict,
        maxCostUsd: parsed.maxCostUsd,
      });
      if (run.dry_run) exitDryRun(run.models_plan, run.strict, parsed.json, {});
      if (parsed.json) {
        process.stdout.write(JSON.stringify({ ok: true, ...run.result, cost_usd: run.cost_usd, models_plan: run.models_plan }) + '\n');
      }
      process.exit(0);
    } catch (err) {
      handleErrorAndExit(err, parsed.json, 2);
    }
  }

  // ── F4: --all batch mode ────────────────────────────────────────────────
  if (parsed.all) {
    try {
      const { runBatchAll } = await import('../core/skillopt/batch.ts');
      const basePlan = await buildModelsPlan(engine, models);
      process.stderr.write(formatModelsBanner(basePlan));
      const result = await runBatchAll({
        engine,
        skillsDir,
        perSkillMaxCostUsd: parsed.maxCostUsd,
        brainWideMaxCostUsd: parsed.brainWideMaxCostUsd ?? 10.0,
        optimizerModel,
        targetModel,
        judgeModel,
        models,
        modelsStrict: parsed.modelsStrict,
        modelsBannerBaseline: basePlan,
        ...(parsed.reflectMaxTokens !== undefined ? { reflectMaxTokens: parsed.reflectMaxTokens } : {}),
        epochs: parsed.epochs,
        batchSize: parsed.batchSize,
        lr: parsed.lr,
        lrSchedule: parsed.lrSchedule,
        split: parsed.split,
        dryRun: parsed.dryRun,
        noMutate: parsed.noMutate,
        allowMutateBundled: parsed.allowMutateBundled,
        force: parsed.force,
      });
      if (parsed.json) {
        process.stdout.write(JSON.stringify({ schema_version: 1, ...result }) + '\n');
      } else {
        process.stderr.write(`[skillopt --all] Scanned ${result.skills_scanned} skills, ran ${result.skills_run}\n`);
        process.stderr.write(`[skillopt --all] Accepted: ${result.accepted}, no_improvement: ${result.no_improvement}, errored: ${result.errored}\n`);
        process.stderr.write(`[skillopt --all] Total cost: $${result.cumulative_cost_usd.toFixed(2)} (cap $${(parsed.brainWideMaxCostUsd ?? 10).toFixed(2)})\n`);
      }
      // Exit code: 0 if at least one accepted, 1 if scanned but none accepted, 2 if errored.
      const exitCode = result.errored > 0 && result.accepted === 0 ? 2
        : result.accepted === 0 ? 1
        : 0;
      process.exit(exitCode);
    } catch (err) {
      handleErrorAndExit(err, parsed.json, 2);
    }
  }

  // ── F5: --target-models fleet mode ──────────────────────────────────────
  if (parsed.targetModelsFleet) {
    try {
      const benchmarkPath = parsed.benchmarkPath ??
        path.join(skillsDir, parsed.skillName, 'skillopt-benchmark.jsonl');
      const { runFleet } = await import('../core/skillopt/batch.ts');
      const result = await runFleet({
        engine,
        skillName: parsed.skillName,
        skillsDir,
        benchmarkPath,
        targetModels: parsed.targetModelsFleet,
        optimizerModel,
        judgeModel,
        models: { optimizer: models.optimizer, judge: models.judge },
        modelsStrict: parsed.modelsStrict,
        ...(parsed.reflectMaxTokens !== undefined ? { reflectMaxTokens: parsed.reflectMaxTokens } : {}),
        epochs: parsed.epochs,
        batchSize: parsed.batchSize,
        lr: parsed.lr,
        lrSchedule: parsed.lrSchedule,
        split: parsed.split,
        dryRun: parsed.dryRun,
        noMutate: parsed.noMutate,
        allowMutateBundled: parsed.allowMutateBundled,
        bootstrapReviewed: parsed.bootstrapReviewed,
        ...(parsed.heldOutPath ? { heldOutPath: parsed.heldOutPath } : {}),
        maxCostUsd: parsed.maxCostUsd,
        maxRuntimeMin: parsed.maxRuntimeMin,
        force: parsed.force,
      });
      if (parsed.json) {
        process.stdout.write(JSON.stringify({ schema_version: 1, ...result }) + '\n');
      } else {
        process.stderr.write(`[skillopt fleet] Per-model scores for '${parsed.skillName}':\n`);
        for (const p of result.per_model) {
          process.stderr.write(`  ${p.target_model}: outcome=${p.outcome} score=${p.best_sel_score.toFixed(3)} cost=$${p.final_cost_usd.toFixed(2)}\n`);
        }
        if (result.best_model) {
          process.stderr.write(`[skillopt fleet] Best model: ${result.best_model} (score ${result.best_score?.toFixed(3) ?? '0'})\n`);
        }
      }
      process.exit(result.best_model ? 0 : 1);
    } catch (err) {
      handleErrorAndExit(err, parsed.json, 2);
    }
  }

  // Build benchmark path.
  const benchmarkPath = parsed.benchmarkPath ??
    path.join(skillsDir, parsed.skillName, 'skillopt-benchmark.jsonl');

  // ── F7: --background submit to Minion queue ─────────────────────────────
  // skillopt is in PROTECTED_JOB_NAMES, so we can't use the generic
  // maybeBackground helper (which doesn't pass allowProtectedSubmit). Inline
  // a small submit that does. Behavior mirrors maybeBackground: writes
  // `job_id=N` to stdout, exits 0; `--follow` execs `gbrain jobs follow`.
  if (args.includes('--background')) {
    if (engine.kind === 'pglite') {
      process.stderr.write('[--background] PGLite has no worker daemon; running inline.\n');
    } else {
      try {
        const { MinionQueue } = await import('../core/minions/queue.ts');
        const queue = new MinionQueue(engine);
        const jobData = buildSkillOptJobData({
          skillsDir,
          skillName: parsed.skillName,
          benchmarkPath,
          epochs: parsed.epochs,
          batchSize: parsed.batchSize,
          lr: parsed.lr,
          lrSchedule: parsed.lrSchedule,
          split: parsed.split,
          models,
          modelFlags,
          modelsStrict: parsed.modelsStrict,
          ...(parsed.reflectMaxTokens !== undefined ? { reflectMaxTokens: parsed.reflectMaxTokens } : {}),
          mode: parsed.mode,
          dryRun: parsed.dryRun,
          noMutate: parsed.noMutate,
          allowMutateBundled: parsed.allowMutateBundled,
          ...(parsed.heldOutPath ? { heldOutPath: parsed.heldOutPath } : {}),
          bootstrapReviewed: parsed.bootstrapReviewed,
          maxCostUsd: parsed.maxCostUsd,
          maxRuntimeMin: parsed.maxRuntimeMin,
          force: parsed.force,
        });
        const job = await queue.add('skillopt', jobData, {
          queue: 'default',
          idempotency_key: `cli:skillopt:${parsed.skillName}`,
          max_attempts: 1,
        }, { allowProtectedSubmit: true });
        process.stdout.write(`job_id=${job.id}\n`);
        if (args.includes('--follow')) {
          const { spawn } = await import('child_process');
          const cmd = process.argv[0] ?? 'bun';
          const script = process.argv[1] ?? '';
          const child = spawn(cmd, [script, 'jobs', 'follow', String(job.id)], { stdio: 'inherit' });
          await new Promise<void>((resolve) => child.on('exit', () => resolve()));
        }
        process.exit(0);
      } catch (err) {
        handleErrorAndExit(err, parsed.json, 2);
      }
    }
  }

  // Build SkillOptOpts.
  const opts: SkillOptOpts = {
    engine,
    skillName: parsed.skillName,
    skillsDir,
    benchmarkPath,
    epochs: parsed.epochs,
    batchSize: parsed.batchSize,
    lr: parsed.lr,
    lrSchedule: parsed.lrSchedule,
    split: parsed.split,
    ...skillOptModelOpts(models),
    modelsStrict: parsed.modelsStrict,
    ...(parsed.reflectMaxTokens !== undefined ? { reflectMaxTokens: parsed.reflectMaxTokens } : {}),
    mode: parsed.mode,
    dryRun: parsed.dryRun,
    noMutate: parsed.noMutate,
    allowMutateBundled: parsed.allowMutateBundled,
    ...(parsed.heldOutPath ? { heldOutPath: parsed.heldOutPath } : {}),
    bootstrapReviewed: parsed.bootstrapReviewed,
    json: parsed.json,
    maxCostUsd: parsed.maxCostUsd,
    maxRuntimeMin: parsed.maxRuntimeMin,
    force: parsed.force,
    ...(parsed.resumeRunId ? { resumeRunId: parsed.resumeRunId } : {}),
  };

  try {
    const result = await runSkillOpt(opts);
    if (parsed.dryRun) {
      exitDryRun(result.receipt.models_plan ?? [], result.receipt.models_strict!, parsed.json, { receipt: result.receipt });
    }
    if (parsed.json) {
      process.stdout.write(JSON.stringify({
        schema_version: 1,
        outcome: result.outcome,
        receipt: result.receipt,
        mutated_skill_file: result.mutatedSkillFile,
        ...(result.proposedPath ? { proposed_path: result.proposedPath } : {}),
      }) + '\n');
    } else {
      process.stderr.write(formatRunSummary(result.outcome, result.receipt, skillsDir));
      process.stderr.write(`[skillopt] Best sel-score: ${(result.receipt.best_sel_score ?? 0).toFixed(3)}\n`);
      process.stderr.write(`[skillopt] Final cost: $${(result.receipt.final_cost_usd ?? 0).toFixed(2)}\n`);
      if (result.mutatedSkillFile) {
        process.stderr.write(`[skillopt] SKILL.md rewritten with ${result.receipt.total_steps ?? 0} optimization steps.\n`);
      } else if (result.proposedPath) {
        process.stderr.write(`[skillopt] Proposed improvements written to ${result.proposedPath}. Review + copy manually.\n`);
      }
    }
    // Exit codes: 0 accepted, 1 no improvement, 2 aborted or errored.
    const exitMap = { accepted: 0, no_improvement: 1, aborted: 2, errored: 2 };
    process.exit(exitMap[result.outcome]);
  } catch (err) {
    handleErrorAndExit(err, parsed.json, 2);
  }
}

type RunSkillOptOutcome = NonNullable<RunReceipt['outcome']>;

/**
 * `--dry-run` exit: the models plan (banner already printed) and the strict
 * verdict, zero model calls. Exit 1 only when strict mode is on and fails.
 */
function exitDryRun(plan: ModelsPlanEntry[], strict: StrictVerdict, json: boolean, extra: Record<string, unknown>): never {
  if (json) {
    process.stdout.write(JSON.stringify({ schema_version: 1, dry_run: true, models_plan: plan, strict, ...extra }) + '\n');
  } else {
    process.stderr.write(`[skillopt] Dry run: no model calls made.\n${describeStrictVerdict(strict)}\n`);
    if (!strict.ok && !strict.enabled) {
      process.stderr.write('(strict mode is off; --models-strict or skillopt.models_strict would abort this run)\n');
    }
  }
  process.exit(strict.enabled && !strict.ok ? 1 : 0);
}

/**
 * Outcome + diagnostics block for the stderr summary. #3516: never a silent
 * failure — say WHY the run aborted/errored. #5584: optimizer-reply errors
 * warn even on a successful run; a retained checkpoint prints the run id,
 * its location and the exact resume command. Exported for unit tests.
 */
export function formatRunSummary(outcome: RunSkillOptOutcome, receipt: RunReceipt, skillsDir: string): string {
  const lines = [`[skillopt] Outcome: ${outcome}`];
  if (outcome === 'aborted' || outcome === 'errored') {
    const detail = receipt.abort_detail ?? '(no detail captured)';
    lines.push(`[skillopt] Failure reason: ${receipt.abort_reason ?? 'unknown'}`);
    lines.push(`[skillopt] Detail: ${detail}`);
    if (detail.includes('no_pricing')) {
      lines.push(`[skillopt] Hint: model has no pricing entry; pass --no-max-cost (or --max-cost-usd 0) to run uncapped with a warn-once.`);
    }
  }
  if (receipt.stop_reason === 'early_stop_unusable_output') {
    lines.push(`[skillopt] Stopped early: optimizer output was unusable for consecutive steps; remaining budget not spent.`);
  }
  const errors = receipt.reflect_errors ?? [];
  if (errors.length > 0) {
    lines.push(`[skillopt] Warning: ${errors.length} optimizer reply error(s) (optimizer output cap ${receipt.reflect_max_tokens ?? 'default'}); first: ${errors[0]}`);
  }
  if (receipt.skill_body_truncated) {
    lines.push(`[skillopt] Warning: skill body truncated for the optimizer (sent ${receipt.skill_body_truncated.sent_chars} of ${receipt.skill_body_truncated.total_chars} chars).`);
  }
  const modelsUsed = receipt.models_used ?? [];
  if (modelsUsed.length > 0) {
    const scope = receipt.models_used_scope === 'since_resume' ? 'since resume; earlier segments predate the ledger' : 'full run';
    lines.push(`[skillopt] Models called (${scope}; a call is one gateway operation, internal retries count once; ~ = estimated cost):`);
    for (const row of formatModelsUsedTable(modelsUsed)) lines.push(`[skillopt]   ${row}`);
  }
  for (const r of receipt.remediation ?? []) {
    lines.push(`[skillopt] Fix (${r.code}): ${r.fix} See ${r.docs}`);
  }
  if (receipt.resume_command) {
    lines.push(`[skillopt] Run id: ${receipt.run_id}`);
    lines.push(`[skillopt] Checkpoint: ${checkpointPath(skillsDir, receipt.skill, receipt.run_id)}`);
    lines.push(`[skillopt] Resume: ${receipt.resume_command}`);
  }
  return lines.join('\n') + '\n';
}

/** Exported for unit tests (CLI flag parsing, --bootstrap-tasks cap, mutual exclusion). */
export function parseFlags(args: string[]): ParsedFlags {
  let skillName = '';
  let benchmarkPath: string | undefined;
  let bootstrapFromRouting = false;
  let bootstrapFromSkill = false;
  let bootstrapTasks: number | undefined;
  let bootstrapReviewed = false;
  let epochs = 4;
  let batchSize = 8;
  let lr = 4;
  let lrSchedule: 'cosine' | 'linear' | 'constant' = 'cosine';
  let splitStr = '4:1:5';
  let optimizerModel: string | undefined;
  let modelsStrict = false;
  let targetModel: string | undefined;
  let judgeModel: string | undefined;
  let reflectMaxTokens: number | undefined;
  let mode: 'patch' | 'rewrite' = 'patch';
  let dryRun = false;
  let noMutate = false;
  let allowMutateBundled = false;
  let heldOutPath: string | undefined;
  let json = false;
  let maxCostUsd = 5.0;
  let maxRuntimeMin = 30;
  let force = false;
  let resumeRunId: string | undefined;
  let skillsDir: string | undefined;
  let help = false;
  let all = false;
  let brainWideMaxCostUsd: number | undefined;
  let targetModelsFleet: string[] | undefined;

  let i = 0;
  while (i < args.length) {
    const a = args[i]!;
    if (a === '--help' || a === '-h') { help = true; i += 1; continue; }
    if (a === '--benchmark') { benchmarkPath = args[++i]; i += 1; continue; }
    if (a === '--bootstrap-from-routing') { bootstrapFromRouting = true; i += 1; continue; }
    if (a === '--bootstrap-from-skill') { bootstrapFromSkill = true; i += 1; continue; }
    if (a === '--bootstrap-tasks') {
      const n = mustInt(args[++i], '--bootstrap-tasks');
      if (n > 50) throw new Error(`--bootstrap-tasks max is 50 (got ${n})`);
      bootstrapTasks = n;
      i += 1; continue;
    }
    if (a === '--bootstrap-reviewed') { bootstrapReviewed = true; i += 1; continue; }
    if (a === '--epochs') { epochs = mustInt(args[++i], '--epochs'); i += 1; continue; }
    if (a === '--batch-size') { batchSize = mustInt(args[++i], '--batch-size'); i += 1; continue; }
    if (a === '--lr') { lr = mustInt(args[++i], '--lr'); i += 1; continue; }
    if (a === '--lr-schedule') {
      const v = args[++i];
      if (v !== 'cosine' && v !== 'linear' && v !== 'constant') {
        throw new Error(`--lr-schedule must be cosine|linear|constant (got '${v}')`);
      }
      lrSchedule = v;
      i += 1; continue;
    }
    if (a === '--split') { splitStr = args[++i]!; i += 1; continue; }
    if (a === '--optimizer-model') { optimizerModel = args[++i]; i += 1; continue; }
    if (a === '--models-strict') { modelsStrict = true; i += 1; continue; }
    if (a === '--target-model') { targetModel = args[++i]; i += 1; continue; }
    if (a === '--judge-model') { judgeModel = args[++i]; i += 1; continue; }
    if (a === '--reflect-max-tokens') {
      const v = args[++i];
      reflectMaxTokens = parsePositiveInt(v);
      if (reflectMaxTokens === undefined) throw new Error(`--reflect-max-tokens requires a positive integer (got '${v}')`);
      i += 1; continue;
    }
    if (a === '--patch') { mode = 'patch'; i += 1; continue; }
    if (a === '--rewrite') { mode = 'rewrite'; i += 1; continue; }
    if (a === '--dry-run') { dryRun = true; i += 1; continue; }
    if (a === '--no-mutate') { noMutate = true; i += 1; continue; }
    if (a === '--allow-mutate-bundled') { allowMutateBundled = true; i += 1; continue; }
    if (a === '--held-out') { heldOutPath = args[++i]; i += 1; continue; }
    if (a === '--json') { json = true; i += 1; continue; }
    // #3516: 0 is accepted and means UNCAPPED — pricing misses for unpriced
    // model ids (openrouter:*, litellm:*) then warn-once instead of aborting
    // the run with BudgetExhausted(no_pricing).
    if (a === '--max-cost-usd') { maxCostUsd = mustNonNegFloat(args[++i], '--max-cost-usd'); i += 1; continue; }
    if (a === '--no-max-cost') { maxCostUsd = 0; i += 1; continue; }
    if (a === '--max-runtime-min') { maxRuntimeMin = mustInt(args[++i], '--max-runtime-min'); i += 1; continue; }
    if (a === '--force') { force = true; i += 1; continue; }
    if (a === '--resume') { resumeRunId = args[++i]; i += 1; continue; }
    if (a === '--skills-dir') { skillsDir = args[++i]; i += 1; continue; }
    if (a === '--all') { all = true; i += 1; continue; }
    if (a === '--brain-wide-max-cost-usd') { brainWideMaxCostUsd = mustFloat(args[++i], '--brain-wide-max-cost-usd'); i += 1; continue; }
    if (a === '--target-models') {
      // F5: comma-separated list. Mutually exclusive with --target-model
      // (single). Triggers fleet mode.
      const v = args[++i];
      if (!v) throw new Error(`--target-models requires a comma-separated list`);
      targetModelsFleet = v.split(',').map((s) => s.trim()).filter(Boolean);
      if (targetModelsFleet.length === 0) throw new Error(`--target-models cannot be empty`);
      i += 1; continue;
    }
    if (a.startsWith('--')) { throw new Error(`unknown flag '${a}'`); }
    if (!skillName) { skillName = a; i += 1; continue; }
    throw new Error(`unexpected positional '${a}'`);
  }

  // --all does NOT require a skill name (it iterates over all skills).
  if (!all && !skillName) throw new Error('skill name is required (positional arg), or use --all for batch mode');
  // Mutual-exclusion check: --benchmark and --bootstrap-from-routing.
  if (benchmarkPath && bootstrapFromRouting) {
    throw new Error(`--benchmark and --bootstrap-from-routing are mutually exclusive`);
  }
  // --all forbids per-skill bootstrap (use the standalone bootstrap path
  // per skill instead).
  if (all && bootstrapFromRouting) {
    throw new Error(`--all and --bootstrap-from-routing are mutually exclusive (run bootstrap per skill)`);
  }
  // --bootstrap-from-skill is a standalone short-circuit: it cannot combine with
  // the other-source / multi-run flags. (--background / --follow are already
  // rejected by the unknown-flag guard since parseFlags doesn't parse them.)
  if (bootstrapFromSkill) {
    if (bootstrapFromRouting) throw new Error(`--bootstrap-from-skill and --bootstrap-from-routing are mutually exclusive`);
    if (benchmarkPath) throw new Error(`--bootstrap-from-skill and --benchmark are mutually exclusive`);
    if (all) throw new Error(`--bootstrap-from-skill and --all are mutually exclusive (run bootstrap per skill)`);
    if (targetModelsFleet) throw new Error(`--bootstrap-from-skill and --target-models are mutually exclusive`);
    if (resumeRunId) throw new Error(`--bootstrap-from-skill and --resume are mutually exclusive`);
  }
  // --bootstrap-tasks only applies to --bootstrap-from-skill.
  if (bootstrapTasks !== undefined && !bootstrapFromSkill) {
    throw new Error(`--bootstrap-tasks requires --bootstrap-from-skill`);
  }
  // --target-models and --target-model are mutually exclusive.
  if (targetModelsFleet && targetModel) {
    throw new Error(`--target-models and --target-model are mutually exclusive`);
  }
  // --target-models + --all is not yet supported (would multiply N×M runs;
  // file as v0.42 follow-up if needed).
  if (targetModelsFleet && all) {
    throw new Error(`--target-models and --all are mutually exclusive in v1`);
  }

  return {
    skillName,
    ...(benchmarkPath !== undefined ? { benchmarkPath } : {}),
    bootstrapFromRouting,
    bootstrapFromSkill,
    ...(bootstrapTasks !== undefined ? { bootstrapTasks } : {}),
    bootstrapReviewed,
    epochs,
    batchSize,
    lr,
    lrSchedule,
    split: parseSplit(splitStr),
    ...(optimizerModel !== undefined ? { optimizerModel } : {}),
    ...(targetModel !== undefined ? { targetModel } : {}),
    ...(judgeModel !== undefined ? { judgeModel } : {}),
    ...(reflectMaxTokens !== undefined ? { reflectMaxTokens } : {}),
    modelsStrict,
    mode,
    dryRun,
    noMutate,
    allowMutateBundled,
    ...(heldOutPath !== undefined ? { heldOutPath } : {}),
    json,
    maxCostUsd,
    maxRuntimeMin,
    force,
    ...(resumeRunId !== undefined ? { resumeRunId } : {}),
    ...(skillsDir !== undefined ? { skillsDir } : {}),
    help,
    all,
    ...(brainWideMaxCostUsd !== undefined ? { brainWideMaxCostUsd } : {}),
    ...(targetModelsFleet !== undefined ? { targetModelsFleet } : {}),
  };
}

function mustInt(v: string | undefined, flag: string): number {
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new Error(`${flag} requires a positive integer (got '${v}')`);
  }
  return n;
}

function mustFloat(v: string | undefined, flag: string): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${flag} requires a positive number (got '${v}')`);
  }
  return n;
}

/** #3516: like mustFloat but 0 is allowed (0 = uncapped for --max-cost-usd). */
function mustNonNegFloat(v: string | undefined, flag: string): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`${flag} requires a non-negative number (got '${v}'; 0 disables the cap)`);
  }
  return n;
}

function handleErrorAndExit(err: unknown, json: boolean, exitCode: number): never {
  if (json) {
    const envelope = err instanceof StructuredAgentError ? err.envelope : serializeError(err);
    process.stderr.write(JSON.stringify({ ok: false, error: envelope }) + '\n');
  } else {
    process.stderr.write(`gbrain skillopt: ${err instanceof Error ? err.message : String(err)}\n`);
    if (err instanceof StructuredAgentError && err.envelope.hint) {
      process.stderr.write(`  hint: ${err.envelope.hint}\n`);
    }
  }
  process.exit(exitCode);
}
