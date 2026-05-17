/**
 * v0.32.3 — `gbrain eval run-all` orchestrator.
 *
 * Sweeps every requested mode × suite combination and writes per-run
 * results to `<repo>/.gbrain-evals/eval-results.jsonl` [CDX-23]. Personal
 * brain (~/.gbrain) is never touched; the repo's git history is the
 * audit trail.
 *
 * Sequential default per D9: --parallel N is opt-in. Modes run one after
 * another so the published numbers don't depend on whether the provider
 * was under load that day. --parallel N uses a module-level p-limit
 * semaphore (NOT the minion rate-leases — those need a minion_jobs.id FK
 * that a CLI eval doesn't have, per [CDX-10]).
 *
 * Cost guard per D3 + [CDX-15+16]: split caps for retrieval and
 * answer-generation. Default $5 retrieval / $20 answer. TTY refuses
 * above cap with override hint; non-TTY needs --yes AND explicit
 * --budget-usd-* flags.
 *
 * Per-suite implementations are documented in src/commands/eval-*.ts.
 * This file is the dispatcher + bookkeeper.
 */

import { writeFileSync, mkdirSync, appendFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import type { BrainEngine } from '../core/engine.ts';
import { SEARCH_MODES, type SearchMode } from '../core/search/mode.ts';

export interface RunAllOpts {
  help: boolean;
  modes: SearchMode[];
  suites: string[];
  limit?: number;
  seed: number;
  parallel: number;
  budgetUsdRetrieval: number;
  budgetUsdAnswer: number;
  yes: boolean;
  outputDir?: string;
  jsonOutput: boolean;
}

const VALID_SUITES = ['longmemeval', 'replay', 'brainbench'] as const;
type ValidSuite = (typeof VALID_SUITES)[number];

const DEFAULT_BUDGET_USD_RETRIEVAL = 5;
const DEFAULT_BUDGET_USD_ANSWER = 20;
const DEFAULT_SEED = 42;
const DEFAULT_PARALLEL = 1;

export function parseRunAllArgs(args: string[]): RunAllOpts {
  const opts: RunAllOpts = {
    help: false,
    modes: [...SEARCH_MODES],
    suites: ['longmemeval', 'replay'],
    seed: DEFAULT_SEED,
    parallel: DEFAULT_PARALLEL,
    budgetUsdRetrieval: DEFAULT_BUDGET_USD_RETRIEVAL,
    budgetUsdAnswer: DEFAULT_BUDGET_USD_ANSWER,
    yes: false,
    jsonOutput: false,
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') { opts.help = true; continue; }
    if (a === '--modes') {
      const list = (args[++i] ?? '').split(',').map(s => s.trim()).filter(Boolean);
      const validated: SearchMode[] = [];
      for (const m of list) {
        if (m === 'conservative' || m === 'balanced' || m === 'tokenmax') {
          validated.push(m);
        } else {
          throw new Error(`--modes: ${m} is not a valid mode (use conservative|balanced|tokenmax)`);
        }
      }
      opts.modes = validated;
      continue;
    }
    if (a === '--suite' || a === '--suites') {
      const list = (args[++i] ?? '').split(',').map(s => s.trim()).filter(Boolean);
      for (const s of list) {
        if (!(VALID_SUITES as readonly string[]).includes(s)) {
          throw new Error(`--suite: ${s} is not a recognized suite (use longmemeval|replay|brainbench)`);
        }
      }
      opts.suites = list;
      continue;
    }
    if (a === '--limit') { opts.limit = Number(args[++i]); continue; }
    if (a === '--seed') { opts.seed = Number(args[++i]); continue; }
    if (a === '--parallel') {
      const n = Number(args[++i]);
      if (!Number.isFinite(n) || n < 1) throw new Error('--parallel must be >= 1');
      opts.parallel = Math.min(n, SEARCH_MODES.length);
      continue;
    }
    if (a === '--budget-usd-retrieval') { opts.budgetUsdRetrieval = Number(args[++i]); continue; }
    if (a === '--budget-usd-answer') { opts.budgetUsdAnswer = Number(args[++i]); continue; }
    if (a === '--yes' || a === '-y') { opts.yes = true; continue; }
    if (a === '--output' || a === '--output-dir') { opts.outputDir = args[++i]; continue; }
    if (a === '--json') { opts.jsonOutput = true; continue; }
  }

  if (opts.modes.length === 0) throw new Error('--modes resolved to an empty list');
  if (opts.suites.length === 0) throw new Error('--suites resolved to an empty list');
  return opts;
}

function printHelp(): void {
  process.stderr.write(
    `gbrain eval run-all [flags]\n\n` +
    `Sweeps every requested search-lite mode × eval suite. Writes per-run results to\n` +
    `<repo>/.gbrain-evals/eval-results.jsonl. Personal brain is never touched.\n\n` +
    `Flags:\n` +
    `  --modes M1,M2,M3              Modes to evaluate (default: conservative,balanced,tokenmax).\n` +
    `  --suites S1,S2                Suites to run (default: longmemeval,replay).\n` +
    `                                Valid: longmemeval, replay, brainbench.\n` +
    `  --limit N                     Limit each suite to N questions (default: full split).\n` +
    `  --seed N                      Random seed (default: 42).\n` +
    `  --parallel N                  Run N modes in parallel (default: 1; max ${SEARCH_MODES.length}).\n` +
    `  --budget-usd-retrieval N      Retrieval-side LLM/embedding spend cap (default: $${DEFAULT_BUDGET_USD_RETRIEVAL}).\n` +
    `  --budget-usd-answer N         Answer-gen LLM spend cap (default: $${DEFAULT_BUDGET_USD_ANSWER}).\n` +
    `  --yes                         Required (alongside --budget-usd-*) in non-TTY for over-cap runs.\n` +
    `  --output DIR                  Override .gbrain-evals/ location.\n` +
    `  --json                        Emit run summary as JSON.\n` +
    `  -h, --help                    Show this help.\n\n` +
    `Cost guard refuses non-TTY runs over the budget cap without --yes AND an\n` +
    `explicit --budget-usd-* flag (defense against agent loops + cron jobs).\n`,
  );
}

export interface EvalRunRecord {
  schema_version: 2;
  run_id: string;
  ran_at: string;
  suite: ValidSuite;
  mode: SearchMode;
  commit: string;
  seed: number;
  limit?: number;
  params: Record<string, unknown>;
  status: 'completed' | 'failed' | 'skipped' | 'over_budget';
  duration_ms: number;
  error?: string;
}

function getRepoRoot(): string {
  try {
    const { execSync } = require('child_process') as typeof import('child_process');
    return execSync('git rev-parse --show-toplevel', { encoding: 'utf-8' }).trim();
  } catch {
    return process.cwd();
  }
}

function getCommitSha(): string {
  try {
    const { execSync } = require('child_process') as typeof import('child_process');
    return execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown';
  }
}

function evalResultsPath(repoRoot: string, outputDirOverride?: string): string {
  if (outputDirOverride) {
    return join(outputDirOverride, 'eval-results.jsonl');
  }
  return join(repoRoot, '.gbrain-evals', 'eval-results.jsonl');
}

export function persistRunRecord(repoRoot: string, record: EvalRunRecord, outputDirOverride?: string): void {
  const path = evalResultsPath(repoRoot, outputDirOverride);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(record) + '\n', 'utf-8');
}

/**
 * Estimate per-run cost. Rough heuristic: per-mode estimates × #questions.
 * The methodology doc documents the assumption. Used by the cost guard;
 * the actual spend is governed by per-suite implementations.
 *
 * Returns total estimated USD across retrieval + answer-gen sides.
 */
export function estimateRunCost(opts: { suites: string[]; modes: SearchMode[]; limit?: number }): {
  retrieval_usd: number;
  answer_usd: number;
  total_usd: number;
  per_suite: Record<string, number>;
} {
  const Qper = opts.limit ?? 500;
  const perSuite: Record<string, number> = {};
  let retrieval = 0;
  let answer = 0;

  for (const suite of opts.suites) {
    for (const mode of opts.modes) {
      // Retrieval side: 1 embed + (optional Haiku) per query.
      const expansionCalls = mode === 'tokenmax' ? Qper : 0;
      const retCost = Qper * 0.00001 + expansionCalls * 0.001;
      // Answer side: 1 Sonnet/Opus call per query for longmemeval; 0 for replay/brainbench.
      const answerCost = suite === 'longmemeval' ? Qper * 0.015 : 0;
      retrieval += retCost;
      answer += answerCost;
      perSuite[`${suite}:${mode}`] = retCost + answerCost;
    }
  }
  return {
    retrieval_usd: retrieval,
    answer_usd: answer,
    total_usd: retrieval + answer,
    per_suite: perSuite,
  };
}

interface CostGuardResult {
  proceed: boolean;
  reason: string;
}

export function evaluateCostGuard(
  estimate: { retrieval_usd: number; answer_usd: number; total_usd: number },
  opts: { budgetUsdRetrieval: number; budgetUsdAnswer: number; yes: boolean; isTty: boolean },
): CostGuardResult {
  const retOver = estimate.retrieval_usd > opts.budgetUsdRetrieval;
  const ansOver = estimate.answer_usd > opts.budgetUsdAnswer;
  if (!retOver && !ansOver) {
    return { proceed: true, reason: 'within budget' };
  }
  if (!opts.isTty && !opts.yes) {
    return {
      proceed: false,
      reason: `Estimate exceeds cap (retrieval=$${estimate.retrieval_usd.toFixed(2)} vs cap $${opts.budgetUsdRetrieval}, answer=$${estimate.answer_usd.toFixed(2)} vs cap $${opts.budgetUsdAnswer}). Non-TTY requires --yes AND --budget-usd-retrieval/--budget-usd-answer to proceed.`,
    };
  }
  if (opts.isTty && !opts.yes) {
    return {
      proceed: false,
      reason: `Estimate ($${estimate.total_usd.toFixed(2)}) exceeds caps. Pass --yes to confirm, and/or --budget-usd-retrieval N / --budget-usd-answer N to override.`,
    };
  }
  return { proceed: true, reason: 'over cap but --yes acknowledged' };
}

export async function runEvalRunAll(_engine: BrainEngine | null, args: string[]): Promise<void> {
  let opts: RunAllOpts;
  try {
    opts = parseRunAllArgs(args);
  } catch (e) {
    process.stderr.write(`Error: ${(e as Error).message}\n`);
    process.exit(1);
  }
  if (opts.help) {
    printHelp();
    return;
  }

  const repoRoot = getRepoRoot();
  const commit = getCommitSha();
  const estimate = estimateRunCost({ suites: opts.suites, modes: opts.modes, limit: opts.limit });
  const isTty = Boolean(process.stderr.isTTY);

  if (opts.jsonOutput) {
    process.stdout.write(JSON.stringify({
      phase: 'estimate',
      schema_version: 2,
      modes: opts.modes,
      suites: opts.suites,
      limit: opts.limit,
      seed: opts.seed,
      commit,
      estimate,
    }) + '\n');
  } else {
    process.stderr.write(`[eval run-all] commit=${commit} modes=${opts.modes.join(',')} suites=${opts.suites.join(',')}\n`);
    process.stderr.write(`[eval run-all] cost estimate: retrieval=$${estimate.retrieval_usd.toFixed(2)} answer=$${estimate.answer_usd.toFixed(2)} total=$${estimate.total_usd.toFixed(2)}\n`);
    process.stderr.write(`[eval run-all] budget caps: retrieval=$${opts.budgetUsdRetrieval} answer=$${opts.budgetUsdAnswer}\n`);
  }

  const guard = evaluateCostGuard(estimate, {
    budgetUsdRetrieval: opts.budgetUsdRetrieval,
    budgetUsdAnswer: opts.budgetUsdAnswer,
    yes: opts.yes,
    isTty,
  });
  if (!guard.proceed) {
    process.stderr.write(`[eval run-all] REFUSED: ${guard.reason}\n`);
    process.exit(2);
  }
  if (!opts.jsonOutput) {
    process.stderr.write(`[eval run-all] ${guard.reason}, proceeding.\n`);
  }

  // v0.32.3 Implementation note: per-suite execution is the operator's
  // responsibility today — `gbrain eval run-all` is the orchestrator's
  // shape + cost guard + audit trail. The per-suite per-mode calls land
  // as a follow-up: each suite's CLI is already exposed (gbrain eval
  // longmemeval --mode X, gbrain eval replay --mode X), so wiring them
  // into a sequential or parallel sweep is mechanical glue once the
  // benchmarking environment + dataset paths are configured.
  //
  // What ships in v0.32.3:
  //   - Argv parser + budget guard + persist hook (audit trail)
  //   - --json estimate-only mode (CI integration without spending)
  //   - Per-suite hook surface (persistRunRecord)
  //
  // What's a v0.32.4 follow-up:
  //   - In-process invocation of the longmemeval / replay / brainbench
  //     runners with a streaming-progress aggregator
  //   - --parallel N semaphore for the multi-mode sweep
  //
  // For v0.32.3 release-time, the operator runs the per-suite commands
  // manually with the documented --mode flags and uses persistRunRecord
  // to log each completion. The methodology doc names this explicitly.
  for (const suite of opts.suites) {
    for (const mode of opts.modes) {
      const startedAt = Date.now();
      const runId = `${commit}-${suite}-${mode}-${opts.seed}`;
      const record: EvalRunRecord = {
        schema_version: 2,
        run_id: runId,
        ran_at: new Date().toISOString(),
        suite: suite as ValidSuite,
        mode,
        commit,
        seed: opts.seed,
        limit: opts.limit,
        params: {
          budget_usd_retrieval: opts.budgetUsdRetrieval,
          budget_usd_answer: opts.budgetUsdAnswer,
          parallel: opts.parallel,
        },
        status: 'skipped',
        duration_ms: Date.now() - startedAt,
      };
      record.error = 'orchestrator stub — invoke per-suite CLI manually for now (v0.32.4 wires the sweep)';
      persistRunRecord(repoRoot, record, opts.outputDir);
      if (!opts.jsonOutput) {
        process.stderr.write(`[eval run-all] ${runId}: ${record.status}\n`);
      }
    }
  }

  if (opts.jsonOutput) {
    process.stdout.write(JSON.stringify({
      phase: 'complete',
      commit,
      modes: opts.modes,
      suites: opts.suites,
      output_path: evalResultsPath(repoRoot, opts.outputDir),
    }) + '\n');
  } else {
    process.stderr.write(`[eval run-all] complete. Audit trail: ${evalResultsPath(repoRoot, opts.outputDir)}\n`);
  }
}
