/**
 * `gbrain eval brainbench` — the cross-harness memory conformance suite
 * (Cathedral 2; docs/eval/BRAINBENCH.md).
 *
 * Brings its own in-memory PGLite (longmemeval pattern) — the cli.ts
 * dispatcher routes here BEFORE connectEngine, so no user brain is ever
 * touched and `--help` works with no DB.
 *
 * Exit contract (decision 9 — the exit code IS the CI product):
 *   0 pass · 1 regression · 2 error / inconclusive / usage
 * PGLite (Emscripten) writes its WASM status into process.exitCode at
 * arbitrary event-loop ticks, and Bun discards queued stdout on
 * process.exit — so the verdict lives in a local variable, `--out FILE` is
 * the canonical CI artifact (written sync before exit), and exit happens
 * explicitly after a short grace tick that lets stdout drain.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { execSync } from 'node:child_process';
import { flushThenExit } from '../core/cli-force-exit.ts';
import { cliOptsToProgressOptions, getCliOptions } from '../core/cli-options.ts';
import { createProgress } from '../core/progress.ts';
import { buildMetricGlossaryMeta } from '../core/eval/metric-glossary.ts';
import { isAvailable } from '../core/ai/gateway.ts';
import { FixtureValidationError, loadCorpus } from '../eval/brainbench/fixtures.ts';
import { runBrainBench } from '../eval/brainbench/harness.ts';
import {
  cellKey,
  compareBaselines,
  parseBaseline,
  renderScoreboardMarkdown,
  serializeBaseline,
  toCanonicalBaseline,
} from '../eval/brainbench/scoreboard.ts';
import {
  ALL_HARNESSES,
  ALL_SUITES,
  RESULT_SCHEMA_VERSION,
  type BrainBenchBaseline,
  type BrainBenchResult,
  type BrainBenchSuite,
  type CompareOutcome,
  type HarnessName,
} from '../eval/brainbench/types.ts';

export const DEFAULT_FIXTURES_DIR = 'evals/brainbench/fixtures';
export const DEFAULT_GOLD_DIR = 'evals/brainbench/gold';
export const DEFAULT_BASELINE_PATH = 'evals/brainbench/baselines/main.json';
const DEFAULT_LLM_BUDGET_USD = 5;

function usage(): void {
  process.stderr.write(
    `Usage: gbrain eval brainbench [options]\n\n` +
      `Cross-harness memory conformance suite. Hermetic by default: in-memory\n` +
      `PGLite, no API keys, no LLM calls. See docs/eval/BRAINBENCH.md.\n\n` +
      `Options:\n` +
      `  --fixtures DIR              Fixture corpus (default: ${DEFAULT_FIXTURES_DIR}).\n` +
      `  --gold DIR                  Sealed gold dir (default: ${DEFAULT_GOLD_DIR}).\n` +
      `  --harness a,b | all         Harness seams to grade (default: all).\n` +
      `  --suite a,b | all           Suites to run (default: all).\n` +
      `  --include-holdout           Score holdout fixtures too (published-run mode).\n` +
      `  --json                      JSON result on stdout instead of the markdown scoreboard.\n` +
      `  --out FILE                  Write the full JSON result to FILE (canonical CI artifact).\n` +
      `  --compare BASE [CURRENT]    Gate against BASE baseline. With CURRENT: pure\n` +
      `                              file-vs-file diff, no run. CI passes MAIN's baseline\n` +
      `                              as BASE (git show origin/master:${DEFAULT_BASELINE_PATH}).\n` +
      `  --committed-baseline FILE   Bless-mode verification target (default: ${DEFAULT_BASELINE_PATH}).\n` +
      `  --update-baseline [FILE]    Write this run as the canonical committed baseline.\n` +
      `  --justification "reason"    Recorded in the baseline written by --update-baseline\n` +
      `                              (REQUIRED by the gate when blessing a regression).\n` +
      `  --allow-regression "reason" One-off escape hatch; reason recorded in the output.\n` +
      `  --llm                       Write-back suite uses the real LLM extractor.\n` +
      `  --budget-usd N              Spend cap for --llm (default: $${DEFAULT_LLM_BUDGET_USD}).\n` +
      `  --seed N                    Recorded in the receipt (default: 42). Reserved —\n` +
      `                              the v1 run is fully deterministic; no knob consumes it yet.\n` +
      `  -h, --help                  Show this help.\n\n` +
      `Exit codes: 0 pass · 1 regression · 2 error/inconclusive/usage.\n`,
  );
}

interface Args {
  fixtures: string;
  gold: string;
  harnesses: HarnessName[];
  suites: BrainBenchSuite[];
  includeHoldout: boolean;
  json: boolean;
  out: string | null;
  compare: string[] | null;
  committedBaseline: string;
  updateBaseline: string | null;
  justification: string | null;
  allowRegression: string | null;
  llm: boolean;
  budgetUsd: number;
  seed: number;
}

function parseArgs(argv: string[]): Args | { usageError: string } {
  const args: Args = {
    fixtures: DEFAULT_FIXTURES_DIR,
    gold: DEFAULT_GOLD_DIR,
    harnesses: [...ALL_HARNESSES],
    suites: [...ALL_SUITES],
    includeHoldout: false,
    json: false,
    out: null,
    compare: null,
    committedBaseline: DEFAULT_BASELINE_PATH,
    updateBaseline: null,
    justification: null,
    allowRegression: null,
    llm: false,
    budgetUsd: DEFAULT_LLM_BUDGET_USD,
    seed: 42,
  };
  const need = (flag: string, v: string | undefined): string => {
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} requires a value`);
    return v;
  };
  try {
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      switch (a) {
        case '-h':
        case '--help':
          return { usageError: '' };
        case '--fixtures':
          args.fixtures = need(a, argv[++i]);
          break;
        case '--gold':
          args.gold = need(a, argv[++i]);
          break;
        case '--harness': {
          const v = need(a, argv[++i]);
          if (v !== 'all') {
            const list = v.split(',').map((s) => s.trim()).filter(Boolean);
            for (const h of list) {
              if (!(ALL_HARNESSES as readonly string[]).includes(h)) {
                return { usageError: `unknown harness "${h}" (valid: ${ALL_HARNESSES.join(', ')}, all)` };
              }
            }
            args.harnesses = list as HarnessName[];
          }
          break;
        }
        case '--suite': {
          const v = need(a, argv[++i]);
          if (v !== 'all') {
            const list = v.split(',').map((s) => s.trim()).filter(Boolean);
            for (const s of list) {
              if (!(ALL_SUITES as readonly string[]).includes(s)) {
                return { usageError: `unknown suite "${s}" (valid: ${ALL_SUITES.join(', ')}, all)` };
              }
            }
            args.suites = list as BrainBenchSuite[];
          }
          break;
        }
        case '--include-holdout':
          args.includeHoldout = true;
          break;
        case '--json':
          args.json = true;
          break;
        case '--out':
          args.out = need(a, argv[++i]);
          break;
        case '--compare': {
          const files = [need(a, argv[++i])];
          if (argv[i + 1] && !argv[i + 1].startsWith('--')) files.push(argv[++i]);
          args.compare = files;
          break;
        }
        case '--committed-baseline':
          args.committedBaseline = need(a, argv[++i]);
          break;
        case '--update-baseline':
          args.updateBaseline =
            argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : DEFAULT_BASELINE_PATH;
          break;
        case '--justification':
          args.justification = need(a, argv[++i]);
          break;
        case '--allow-regression':
          args.allowRegression = need(a, argv[++i]);
          break;
        case '--llm':
          args.llm = true;
          break;
        case '--budget-usd':
          args.budgetUsd = Number(need(a, argv[++i]));
          if (!Number.isFinite(args.budgetUsd) || args.budgetUsd <= 0) {
            return { usageError: '--budget-usd must be a positive number' };
          }
          break;
        case '--seed':
          args.seed = Number(need(a, argv[++i]));
          if (!Number.isInteger(args.seed)) return { usageError: '--seed must be an integer' };
          break;
        default:
          return { usageError: `unknown flag ${a}` };
      }
    }
  } catch (err) {
    return { usageError: (err as Error).message };
  }
  return args;
}

function gitHeadSha(): string {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown';
  }
}

/**
 * Bun discards queued stdout on process.exit and PGLite stomps
 * process.exitCode on its own ticks — hold the verdict locally and exit
 * through the #2084 central seam (write-fence + ref'd aliveness grace),
 * which exists for exactly this trap.
 */
async function exitWith(code: 0 | 1 | 2): Promise<never> {
  flushThenExit(code);
  // flushThenExit exits after its bounded fence + grace; never resolve.
  return new Promise<never>(() => {});
}

function readBaselineFile(path: string): BrainBenchBaseline {
  return parseBaseline(readFileSync(path, 'utf-8'), path);
}

function verdictExit(outcome: CompareOutcome): 0 | 1 | 2 {
  switch (outcome.verdict) {
    case 'pass':
      return 0;
    case 'regression':
      return 1;
    case 'inconclusive':
      return 2;
  }
}

export async function runEvalBrainBench(argv: string[]): Promise<never> {
  const parsed = parseArgs(argv);
  if ('usageError' in parsed) {
    if (parsed.usageError) process.stderr.write(`eval brainbench: ${parsed.usageError}\n\n`);
    usage();
    return exitWith(2);
  }
  const args = parsed;

  // Pure file-vs-file compare: no run, no DB.
  if (args.compare && args.compare.length === 2) {
    let outcome: CompareOutcome;
    try {
      const base = readBaselineFile(args.compare[0]);
      const current = readBaselineFile(args.compare[1]);
      outcome = compareBaselines(current, base, {
        allowRegression: args.allowRegression ?? undefined,
      });
    } catch (err) {
      process.stderr.write(`eval brainbench: ${(err as Error).message}\n`);
      return exitWith(2);
    }
    process.stdout.write(JSON.stringify(outcome, null, 2) + '\n');
    return exitWith(verdictExit(outcome));
  }

  // --llm needs a configured chat touchpoint BEFORE we spend a run on it.
  if (args.llm && !isAvailable('chat')) {
    process.stderr.write(
      'eval brainbench: --llm requires a configured chat model (set ANTHROPIC_API_KEY or run `gbrain models`). ' +
        'Drop --llm for the deterministic hermetic mode.\n',
    );
    return exitWith(2);
  }

  const reporter = createProgress(cliOptsToProgressOptions(getCliOptions()));
  let result: BrainBenchResult;
  try {
    const corpus = await loadCorpus(args.fixtures, args.gold);
    if (corpus.fixtures.length === 0) {
      process.stderr.write(`eval brainbench: no fixtures found in ${args.fixtures} — refusing a vacuous pass.\n`);
      return exitWith(2);
    }
    // No total: continuity pairs replay per (writer,reader) ordering, so the
    // tick count exceeds the fixture count — a percentage would lie.
    reporter.start('eval.brainbench');
    const run = await runBrainBench(corpus, {
      harnesses: args.harnesses,
      suites: args.suites,
      includeHoldout: args.includeHoldout,
      llm: args.llm,
      budgetUsd: args.budgetUsd,
      onProgress: (note) => reporter.tick(1, note),
    });
    reporter.finish();

    // Seed failures FIRST: an all-fixtures-failed-to-seed run would otherwise
    // be misdiagnosed as "filters matched nothing" (same exit, wrong story).
    if (run.seed_failures.length > 0) {
      process.stderr.write(`eval brainbench: SEED FAILURES (${run.seed_failures.length}) — run invalid:\n`);
      for (const f of run.seed_failures) {
        process.stderr.write(`  - ${f.fixture_id}: ${f.error}\n`);
      }
    } else if (run.fixtures_run === 0 || run.cells.length === 0) {
      process.stderr.write(
        'eval brainbench: the harness/suite filters matched zero fixtures — refusing a vacuous pass.\n',
      );
      return exitWith(2);
    }

    const metricNames = [...new Set(run.cells.flatMap((c) => Object.keys(c.metrics)))].sort();
    result = {
      receipt: {
        result_schema_version: RESULT_SCHEMA_VERSION,
        fixtures_hash: corpus.fixtures_hash,
        harness_sha: gitHeadSha(),
        ts: new Date().toISOString(),
        cmd_args: argv,
        seed: args.seed,
        include_holdout: args.includeHoldout,
        llm: args.llm,
      },
      cells: run.cells,
      turn_rows: run.turn_rows,
      seed_failures: run.seed_failures,
      _meta: { metric_glossary: buildMetricGlossaryMeta(metricNames) },
    };
  } catch (err) {
    reporter.finish('aborted');
    const prefix = err instanceof FixtureValidationError ? 'fixture validation' : 'run failed';
    process.stderr.write(`eval brainbench: ${prefix}: ${(err as Error).message}\n`);
    return exitWith(2);
  }

  // Decide verdict BEFORE emitting (seed failures invalidate everything).
  let exitCode: 0 | 1 | 2 = 0;
  let compareOutcome: CompareOutcome | null = null;
  const runConfig = { harnesses: args.harnesses, suites: args.suites };

  // Baseline write happens BEFORE compare (red-team finding: the documented
  // one-shot `--compare MAIN --update-baseline` flow used to read the stale
  // committed file, exit 2, then overwrite it — training users to ignore
  // exit 2). A run with seed failures NEVER writes a baseline: partial cells
  // as the canonical gate target would be garbage with receipts.
  if (args.updateBaseline) {
    if (result.seed_failures.length > 0) {
      process.stderr.write(
        '[eval brainbench] REFUSING --update-baseline: run has seed failures (partial cells are not a baseline)\n',
      );
    } else {
      const baseline = toCanonicalBaseline(result, args.justification ?? undefined, runConfig);
      mkdirSync(dirname(args.updateBaseline), { recursive: true });
      writeFileSync(args.updateBaseline, serializeBaseline(baseline));
      process.stderr.write(`[eval brainbench] baseline written: ${args.updateBaseline}\n`);
    }
  }

  if (result.seed_failures.length > 0) {
    exitCode = 2;
  } else if (args.compare) {
    try {
      const main = readBaselineFile(args.compare[0]);
      const current = toCanonicalBaseline(result, undefined, runConfig);
      // Always consult the committed baseline when present — same-hash drift
      // detection (two-PR gate poisoning) needs it as much as bless mode.
      const committed: BrainBenchBaseline | null = existsSync(args.committedBaseline)
        ? readBaselineFile(args.committedBaseline)
        : null;
      compareOutcome = compareBaselines(current, main, {
        allowRegression: args.allowRegression ?? undefined,
        committedBaseline: committed,
      });
      exitCode = verdictExit(compareOutcome);
    } catch (err) {
      process.stderr.write(`eval brainbench: compare failed: ${(err as Error).message}\n`);
      exitCode = 2;
    }
  }

  // Canonical CI artifact first (sync write completes before any exit).
  if (args.out) {
    const outDoc = { ...result, compare: compareOutcome ?? undefined };
    mkdirSync(dirname(args.out), { recursive: true });
    writeFileSync(args.out, JSON.stringify(outDoc, null, 2) + '\n');
    process.stderr.write(`[eval brainbench] result written: ${args.out}\n`);
  }

  if (args.json) {
    process.stdout.write(JSON.stringify({ ...result, compare: compareOutcome ?? undefined }) + '\n');
  } else {
    process.stdout.write(renderScoreboardMarkdown(result, compareOutcome));
  }

  return exitWith(exitCode);
}

/**
 * In-process entry for `gbrain eval run-all` (decision 16): full hermetic run
 * over the default corpus, NO process.exit, returns the per-cell metrics for
 * the EvalRunRecord. BrainBench is search-mode-independent, so run-all calls
 * this once per sweep and records it under mode 'n/a'.
 */
export async function runBrainBenchCore(): Promise<{
  status: 'completed' | 'failed';
  fixtures_hash?: string;
  cells?: Record<string, Record<string, number>>;
  error?: string;
}> {
  try {
    const corpus = await loadCorpus(DEFAULT_FIXTURES_DIR, DEFAULT_GOLD_DIR);
    if (corpus.fixtures.length === 0) {
      return { status: 'failed', error: `no fixtures in ${DEFAULT_FIXTURES_DIR}` };
    }
    const run = await runBrainBench(corpus, {
      harnesses: [...ALL_HARNESSES],
      suites: [...ALL_SUITES],
      includeHoldout: false,
      llm: false,
    });
    if (run.seed_failures.length > 0) {
      return {
        status: 'failed',
        fixtures_hash: corpus.fixtures_hash,
        error: `seed failures: ${run.seed_failures.map((f) => f.fixture_id).join(', ')}`,
      };
    }
    const cells: Record<string, Record<string, number>> = {};
    for (const c of run.cells) {
      cells[cellKey(c)] = { ...c.metrics, gold_failed: c.gold_failed, gold_total: c.gold_total };
    }
    return { status: 'completed', fixtures_hash: corpus.fixtures_hash, cells };
  } catch (err) {
    return { status: 'failed', error: (err as Error).message };
  }
}

/** Test hook: everything above process.exit, without exiting. */
export const _internal = { parseArgs, DEFAULT_BASELINE_PATH };
