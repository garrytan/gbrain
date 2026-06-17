/**
 * v0.34 pre-w0 — `gbrain eval code-retrieval` CLI.
 *
 * Subcommands:
 *   --baseline           Capture pre-v0.34 retrieval quality. Saves the number
 *                        v0.34 must beat. Run 3x for noise floor.
 *   --with-code-intel    Run against v0.34's code-intel MCP ops. Pre-W3 this
 *                        returns mostly-empty results (honest baseline).
 *   --compare A B        Read two saved reports and compute the gate verdict.
 *
 * Output:
 *   stdout — human-readable table by default; `--json` for machine.
 *   `--save <path>` writes the EvalRunReport JSON to disk.
 *
 * The CLI deliberately separates capture (read-only) from compare (pure JSON
 * read) so the eval data can move between machines / CI without re-running
 * against a brain.
 */

import { writeFileSync, existsSync, readFileSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { mkdirSync } from 'fs';
import type { BrainEngine } from '../core/engine.ts';
import {
  loadQuestions,
  runCodeRetrievalEval,
  evaluateGate,
  DEFAULT_GATE,
  type EvalRunReport,
} from '../eval/code-retrieval/harness.ts';
import { BaselineStrategy, WithCodeIntelStrategy } from '../eval/code-retrieval/strategies.ts';
import { createProgress } from '../core/progress.ts';
import { getCliOptions, cliOptsToProgressOptions } from '../core/cli-options.ts';

interface ParsedArgs {
  help: boolean;
  baseline: boolean;
  withCodeIntel: boolean;
  compare?: { a: string; b: string };
  corpus: string;
  questionsPath: string;
  source?: string;
  k: number;
  save?: string;
  json: boolean;
}

const DEFAULT_QUESTIONS_PATH = 'src/eval/code-retrieval/questions.json';

function parseArgs(args: string[]): ParsedArgs {
  const out: ParsedArgs = {
    help: false,
    baseline: false,
    withCodeIntel: false,
    corpus: 'gbrain',
    questionsPath: DEFAULT_QUESTIONS_PATH,
    k: 5,
    json: false,
  };
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--baseline') out.baseline = true;
    else if (a === '--with-code-intel') out.withCodeIntel = true;
    else if (a === '--compare') {
      const aPath = args[++i];
      const bPath = args[++i];
      if (!aPath || !bPath) throw new Error('--compare requires two file paths');
      out.compare = { a: aPath, b: bPath };
    } else if (a === '--corpus') out.corpus = args[++i] ?? 'gbrain';
    else if (a === '--questions') out.questionsPath = args[++i] ?? DEFAULT_QUESTIONS_PATH;
    else if (a === '--source') out.source = args[++i];
    else if (a === '--k') out.k = parseInt(args[++i] ?? '5', 10);
    else if (a === '--save') out.save = args[++i];
    else if (a === '--json') out.json = true;
    i++;
  }
  return out;
}

function printHelp(): void {
  process.stdout.write(`
gbrain eval code-retrieval — v0.34 retrieval baseline + gate

Capture a retrieval-quality number against a curated question set. The
baseline captured here is what v0.34 must beat (precision@5 +10pp OR
answered_rate +15pp on >=15/30 questions).

USAGE:
  gbrain eval code-retrieval --baseline [--corpus NAME] [--save PATH] [--json]
  gbrain eval code-retrieval --with-code-intel [--corpus NAME] [--save PATH] [--json]
  gbrain eval code-retrieval --compare BASELINE.json WITH_CODE_INTEL.json [--json]

OPTIONS:
  --baseline               Capture pre-v0.34 retrieval (query + search only)
  --with-code-intel        Capture v0.34 mode (code_blast / code_flow / etc.)
  --compare A B            Compare two saved reports; emits gate pass/fail
  --corpus NAME            Brain corpus to query (default: gbrain)
  --questions PATH         Question file (default: ${DEFAULT_QUESTIONS_PATH})
  --source SOURCE_ID       Source to scope queries to (default: brain default)
  --k N                    Top-k cutoff (default: 5)
  --save PATH              Write EvalRunReport JSON to disk
  --json                   Machine-readable JSON to stdout
  -h, --help               This help

PRE-V0.34 BASELINE WORKFLOW (the assignment):
  # Capture baseline 3x for noise floor
  gbrain eval code-retrieval --baseline --save /tmp/baseline-1.json
  gbrain eval code-retrieval --baseline --save /tmp/baseline-2.json
  gbrain eval code-retrieval --baseline --save /tmp/baseline-3.json

V0.34 SHIP GATE:
  # After v0.34 ships, capture the with-code-intel run and compare
  gbrain eval code-retrieval --with-code-intel --save /tmp/v034.json
  gbrain eval code-retrieval --compare /tmp/baseline-1.json /tmp/v034.json
`);
}

export async function runEvalCodeRetrieval(engine: BrainEngine, args: string[]): Promise<void> {
  let opts: ParsedArgs;
  try {
    opts = parseArgs(args);
  } catch (err: any) {
    process.stderr.write(`error: ${err.message}\n`);
    process.exit(2);
    return;
  }

  if (opts.help) {
    printHelp();
    return;
  }

  // --compare mode: pure JSON read, no engine needed (engine still passed by
  // the dispatcher; we just don't touch it).
  if (opts.compare) {
    return runCompare(opts);
  }

  if (!opts.baseline && !opts.withCodeIntel) {
    process.stderr.write('error: specify --baseline or --with-code-intel (or --compare)\n');
    printHelp();
    process.exit(2);
    return;
  }

  const questions = loadQuestions(resolve(opts.questionsPath));
  const sourceId = opts.source ?? (await resolveDefaultSource(engine));

  const strategy = opts.baseline
    ? new BaselineStrategy(engine, sourceId)
    : new WithCodeIntelStrategy(engine, sourceId);

  const progress = createProgress(cliOptsToProgressOptions(getCliOptions()));
  progress.start(`eval.code_retrieval.${strategy.mode}`, questions.questions.length);

  const report = await runCodeRetrievalEval(questions.questions, strategy, {
    k: opts.k,
    corpus: opts.corpus,
    onProgress: (done, _total, qid) => progress.tick(1, qid),
  });

  progress.finish();

  if (opts.save) {
    const savePath = resolve(opts.save);
    mkdirSync(dirname(savePath), { recursive: true });
    writeFileSync(savePath, JSON.stringify(report, null, 2));
    process.stderr.write(`[eval] saved report to ${savePath}\n`);
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return;
  }

  printSingleReport(report);
}

function runCompare(opts: ParsedArgs): void {
  if (!opts.compare) return;
  const aPath = resolve(opts.compare.a);
  const bPath = resolve(opts.compare.b);
  for (const p of [aPath, bPath]) {
    if (!existsSync(p)) {
      process.stderr.write(`error: report not found at ${p}\n`);
      process.exit(2);
      return;
    }
  }
  const a: EvalRunReport = JSON.parse(readFileSync(aPath, 'utf8'));
  const b: EvalRunReport = JSON.parse(readFileSync(bPath, 'utf8'));

  // Convention: the first arg is baseline, the second is with-code-intel.
  // If labels disagree, swap so the comparison is meaningful.
  let baseline = a;
  let withCodeIntel = b;
  if (a.mode === 'with-code-intel' && b.mode === 'baseline') {
    baseline = b;
    withCodeIntel = a;
  }

  const gate = evaluateGate(baseline, withCodeIntel, DEFAULT_GATE);

  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        {
          schema_version: 1,
          passed: gate.passed,
          precision_delta_pp: gate.precision_delta_pp,
          top_1_stability_rate: gate.top_1_stability_rate,
          questions_cleared_bar: gate.questions_cleared_bar,
          questions_total: gate.questions_total,
          summary: gate.summary,
        },
        null,
        2,
      ) + '\n',
    );
    process.exit(gate.passed ? 0 : 1);
    return;
  }

  process.stdout.write(`\n${gate.summary}\n\n`);
  process.stdout.write(`baseline:        precision@${baseline.k}=${(baseline.mean_precision_at_k * 100).toFixed(1)}%   answered=${(baseline.answered_rate * 100).toFixed(1)}%   (commit ${baseline.commit})\n`);
  process.stdout.write(`with-code-intel: precision@${withCodeIntel.k}=${(withCodeIntel.mean_precision_at_k * 100).toFixed(1)}%   answered=${(withCodeIntel.answered_rate * 100).toFixed(1)}%   (commit ${withCodeIntel.commit})\n`);
  process.stdout.write(`delta:           +${gate.precision_delta_pp.toFixed(1)}pp precision   top-1 stability=${(gate.top_1_stability_rate * 100).toFixed(1)}%\n`);
  process.stdout.write(`cleared bar:     ${gate.questions_cleared_bar}/${gate.questions_total}\n\n`);

  process.exit(gate.passed ? 0 : 1);
}

function printSingleReport(report: EvalRunReport): void {
  process.stdout.write(`\n=== code-retrieval eval (mode=${report.mode}) ===\n`);
  process.stdout.write(`corpus:      ${report.corpus}\n`);
  process.stdout.write(`commit:      ${report.commit}\n`);
  process.stdout.write(`captured:    ${report.captured_at}\n`);
  process.stdout.write(`questions:   ${report.questions.length}\n`);
  process.stdout.write(`precision@${report.k}: ${(report.mean_precision_at_k * 100).toFixed(1)}%\n`);
  process.stdout.write(`answered:    ${report.questions.filter((q) => q.answered).length}/${report.questions.length} (${(report.answered_rate * 100).toFixed(1)}%)\n`);
  process.stdout.write(`latency:     ${report.total_latency_ms}ms total, ${(report.total_latency_ms / Math.max(1, report.questions.length)).toFixed(0)}ms/q\n`);
  process.stdout.write(`\nper-question:\n`);
  for (const q of report.questions) {
    const status = q.answered ? '✓' : '✗';
    process.stdout.write(`  ${status} ${q.id.padEnd(20)} p@${report.k}=${(q.precision_at_k * 100).toFixed(0)}% recall@${report.k}=${(q.recall_at_k * 100).toFixed(0)}% (${q.latency_ms}ms)\n`);
  }
  process.stdout.write('\n');
}

async function resolveDefaultSource(engine: BrainEngine): Promise<string> {
  // Try the engine's listSources if it exists; otherwise return a sensible default.
  // Most brains have one source; this picks that one.
  const sources = await (engine as any).listSources?.();
  if (Array.isArray(sources) && sources.length > 0) {
    return sources[0].id ?? 'default';
  }
  return 'default';
}
