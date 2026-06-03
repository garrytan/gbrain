/**
 * `gbrain skillopt <skill> [flags]` CLI dispatcher.
 *
 * Top-level command (not under `gbrain eval`) because it MUTATES files.
 * See: src/core/skillopt/ for the implementation modules.
 */

import * as path from 'node:path';
import { resolveModel } from '../core/model-config.ts';
import { autoDetectSkillsDirReadOnly } from '../core/repo-root.ts';
import { runBootstrap, runBootstrapFromSkill } from '../core/skillopt/bootstrap-benchmark.ts';
import { SKILLOPT_HELP_TEXT } from '../core/skillopt/help.ts';
import { runSkillOpt, parseSplit } from '../core/skillopt/orchestrator.ts';
import { serializeError, StructuredAgentError } from '../core/errors.ts';
import type { BrainEngine } from '../core/engine.ts';
import type { SkillOptOpts } from '../core/skillopt/types.ts';

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

  // Resolve models via the tier system.
  const optimizerModel = parsed.optimizerModel
    ?? await resolveModel(engine, { tier: 'deep', fallback: 'anthropic:claude-opus-4-7' });
  const targetModel = parsed.targetModel
    ?? await resolveModel(engine, { tier: 'subagent', fallback: 'anthropic:claude-sonnet-4-6' });
  const judgeModel = parsed.judgeModel
    ?? await resolveModel(engine, { tier: 'reasoning', fallback: 'anthropic:claude-sonnet-4-6' });

  // ── Bootstrap mode (short-circuits before the optimization loop) ────────
  if (parsed.bootstrapFromRouting) {
    try {
      const result = await runBootstrap({
        skillsDir,
        skillName: parsed.skillName,
        optimizerModel,
        force: parsed.force,
      });
      if (parsed.json) {
        process.stdout.write(JSON.stringify({ ok: true, ...result }) + '\n');
      }
      process.exit(0);
    } catch (err) {
      handleErrorAndExit(err, parsed.json, 2);
    }
  }

  // ── Bootstrap-from-skill mode (short-circuits before the optimization loop) ─
  // Reads SKILL.md directly (no routing-eval needed), emits a full starter
  // benchmark, writes the D15 sentinel. Provider errors propagate so the user
  // sees the real failure instead of "0 tasks".
  if (parsed.bootstrapFromSkill) {
    try {
      const result = await runBootstrapFromSkill({
        skillsDir,
        skillName: parsed.skillName,
        optimizerModel,
        taskCount: parsed.bootstrapTasks ?? 15,
        force: parsed.force,
      });
      if (parsed.json) {
        process.stdout.write(JSON.stringify({ ok: true, ...result }) + '\n');
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
      const result = await runBatchAll({
        engine,
        skillsDir,
        perSkillMaxCostUsd: parsed.maxCostUsd,
        brainWideMaxCostUsd: parsed.brainWideMaxCostUsd ?? 10.0,
        optimizerModel,
        targetModel,
        judgeModel,
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
        const jobData = {
          skills_dir: skillsDir,
          skill_name: parsed.skillName,
          benchmark_path: benchmarkPath,
          epochs: parsed.epochs,
          batch_size: parsed.batchSize,
          lr: parsed.lr,
          lr_schedule: parsed.lrSchedule,
          split: parsed.split,
          optimizer_model: optimizerModel,
          target_model: targetModel,
          judge_model: judgeModel,
          mode: parsed.mode,
          dry_run: parsed.dryRun,
          no_mutate: parsed.noMutate,
          allow_mutate_bundled: parsed.allowMutateBundled,
          ...(parsed.heldOutPath ? { held_out_path: parsed.heldOutPath } : {}),
          bootstrap_reviewed: parsed.bootstrapReviewed,
          max_cost_usd: parsed.maxCostUsd,
          max_runtime_min: parsed.maxRuntimeMin,
          force: parsed.force,
        };
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
    optimizerModel,
    targetModel,
    judgeModel,
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
    if (parsed.json) {
      process.stdout.write(JSON.stringify({
        schema_version: 1,
        outcome: result.outcome,
        receipt: result.receipt,
        mutated_skill_file: result.mutatedSkillFile,
        ...(result.proposedPath ? { proposed_path: result.proposedPath } : {}),
      }) + '\n');
    } else {
      process.stderr.write(`[skillopt] Outcome: ${result.outcome}\n`);
      process.stderr.write(`[skillopt] Best sel-score: ${(result.receipt.best_sel_score ?? 0).toFixed(3)}\n`);
      process.stderr.write(`[skillopt] Final cost: $${(result.receipt.final_cost_usd ?? 0).toFixed(2)}\n`);
      if (result.mutatedSkillFile) {
        process.stderr.write(`[skillopt] SKILL.md rewritten with ${result.receipt.total_steps ?? 0} optimization steps.\n`);
      } else if (result.proposedPath) {
        process.stderr.write(`[skillopt] Proposed improvements written to ${result.proposedPath}. Review + copy manually.\n`);
      }
    }
    // Exit codes: 0 accepted, 1 no improvement, 2 aborted, 3 errored.
    const exitMap = { accepted: 0, no_improvement: 1, aborted: 2, errored: 2 };
    process.exit(exitMap[result.outcome]);
  } catch (err) {
    handleErrorAndExit(err, parsed.json, 2);
  }
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
  let targetModel: string | undefined;
  let judgeModel: string | undefined;
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
    if (a === '--target-model') { targetModel = args[++i]; i += 1; continue; }
    if (a === '--judge-model') { judgeModel = args[++i]; i += 1; continue; }
    if (a === '--patch') { mode = 'patch'; i += 1; continue; }
    if (a === '--rewrite') { mode = 'rewrite'; i += 1; continue; }
    if (a === '--dry-run') { dryRun = true; i += 1; continue; }
    if (a === '--no-mutate') { noMutate = true; i += 1; continue; }
    if (a === '--allow-mutate-bundled') { allowMutateBundled = true; i += 1; continue; }
    if (a === '--held-out') { heldOutPath = args[++i]; i += 1; continue; }
    if (a === '--json') { json = true; i += 1; continue; }
    if (a === '--max-cost-usd') { maxCostUsd = mustFloat(args[++i], '--max-cost-usd'); i += 1; continue; }
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
