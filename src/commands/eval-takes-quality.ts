/**
 * gbrain eval takes-quality — reproducible cross-modal eval CLI for
 * the takes table (v0.32 — EXP-5).
 *
 * Sub-subcommands:
 *   run                          — score N takes via the 3-model panel
 *   replay <receipt-path>         — load a prior receipt from disk (NO BRAIN)
 *   trend                        — rubric-versioned trend table
 *   regress --against <receipt>  — fresh run vs prior receipt; exit 1 on regression
 *
 * Codex review #10 brain-routing: replay is the ONLY mode that doesn't
 * require a brain. The cli.ts no-DB bypass routes `replay` here directly;
 * run/trend/regress go through connectEngine in cli.ts.
 *
 * Codex review #4 fail-closed budget: `--budget-usd N` aborts before the
 * next call's projected cost would exceed the cap. Models without a
 * pricing entry produce an actionable error, not silent zero.
 *
 * Codex review #3 receipt naming: every run binds (corpus, prompt, models,
 * rubric) shas; rubric_version field segregates trend rows by rubric epoch.
 */
import type { BrainEngine } from '../core/engine.ts';
import { configureGateway } from '../core/ai/gateway.ts';
import { loadConfig } from '../core/config.ts';
import { runEval, DEFAULT_MODEL_PANEL } from '../core/takes-quality-eval/runner.ts';
import { writeReceipt } from '../core/takes-quality-eval/receipt-write.ts';
import { loadReceiptFromDisk } from '../core/takes-quality-eval/replay.ts';
import { compareReceipts } from '../core/takes-quality-eval/regress.ts';
import { loadTrend, renderTrendTable, type TrendRow } from '../core/takes-quality-eval/trend.ts';

const HELP = `gbrain eval takes-quality — reproducible cross-modal quality eval

Subcommands:
  run [--limit N] [--seed N] [--budget-usd N] [--source db|fs]
      [--slug-prefix P] [--cycles N] [--models a,b,c] [--json]
    Sample N takes from the brain, score with 3 models in parallel,
    aggregate to PASS/FAIL/INCONCLUSIVE. Default: --limit 100, --cycles 3
    (1 in non-TTY), --source db, --budget-usd null (no cap; pass 0 to
    explicitly disable budget enforcement). Default models:
      ${DEFAULT_MODEL_PANEL.join(', ')}
    Exit codes: 0 PASS, 1 FAIL, 2 INCONCLUSIVE.

  replay <receipt-path> [--json]
    Load a prior receipt from disk and re-render it. NO BRAIN REQUIRED —
    works without DATABASE_URL. The receipt is the source of truth; this
    mode does NOT silently fall back to the DB if the file is missing.

  trend [--limit N] [--rubric-version V] [--json]
    Rubric-versioned table of recent runs from the DB.

  regress --against <receipt-path> [--limit N] [--threshold T] [--json]
    Run a fresh eval and compare against a prior receipt. Reports per-dim
    deltas and exits 1 if any dim regressed past --threshold (default 0.5).
`;

export interface EvalTakesQualityArgs {
  subcmd: 'run' | 'replay' | 'trend' | 'regress' | 'help';
  argv: string[];
  json: boolean;
}

export function parseSubcmd(args: string[]): EvalTakesQualityArgs {
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    return { subcmd: 'help', argv: [], json: false };
  }
  const subcmd = args[0] as EvalTakesQualityArgs['subcmd'];
  if (!['run', 'replay', 'trend', 'regress'].includes(subcmd)) {
    return { subcmd: 'help', argv: [], json: false };
  }
  const argv = args.slice(1);
  const json = argv.includes('--json');
  return { subcmd, argv, json };
}

function getFlag(argv: string[], name: string): string | undefined {
  // Supports --name=value AND --name value forms.
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith(`${name}=`)) return a.slice(name.length + 1);
    if (a === name) return argv[i + 1];
  }
  return undefined;
}
function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(name);
}

/**
 * No-DB path: replay is the only sub-subcommand that doesn't need an engine
 * (codex review #10). cli.ts routes here directly without connectEngine.
 */
export async function runReplayNoBrain(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv[0].startsWith('-')) {
    process.stderr.write('Usage: gbrain eval takes-quality replay <receipt-path> [--json]\n');
    return 2;
  }
  const receiptPath = argv[0];
  const json = argv.includes('--json');
  try {
    const receipt = loadReceiptFromDisk(receiptPath);
    if (json) {
      console.log(JSON.stringify(receipt, null, 2));
    } else {
      console.log(`Receipt: ${receiptPath}`);
      console.log(`  ts:             ${receipt.ts}`);
      console.log(`  rubric_version: ${receipt.rubric_version}`);
      console.log(`  verdict:        ${receipt.verdict}`);
      console.log(`  overall_score:  ${receipt.overall_score ?? 'n/a'}`);
      console.log(`  cost_usd:       $${receipt.cost_usd.toFixed(4)}`);
      console.log(`  cycles_run:     ${receipt.cycles_run}`);
      console.log(`  successes:      [${receipt.successes_per_cycle.join(', ')}]`);
      console.log(`  models:         ${receipt.models.join(', ')}`);
      if (receipt.verdictMessage) console.log(`  verdict msg:    ${receipt.verdictMessage}`);
    }
    return verdictExitCode(receipt.verdict);
  } catch (e) {
    process.stderr.write(`replay failed: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

/**
 * Engine-required path: handles run / trend / regress. cli.ts routes here
 * with an open engine.
 */
export async function runEvalTakesQuality(engine: BrainEngine, args: string[]): Promise<void> {
  // Self-configure the AI gateway (mirrors eval-cross-modal pattern). The
  // gateway needs config.ai_gateway + env vars; configureGateway reads both.
  const cfg = loadConfig();
  configureGateway({ ...cfg, ...(process.env as Record<string, string>) } as any);

  const { subcmd, argv, json } = parseSubcmd(args);

  if (subcmd === 'help') {
    console.log(HELP);
    return;
  }

  if (subcmd === 'run') {
    const limit = parseIntFlag(argv, '--limit', 100);
    const cycles = parseIntFlag(argv, '--cycles', process.stdout.isTTY ? 3 : 1);
    const budgetStr = getFlag(argv, '--budget-usd');
    const budgetUsd = budgetStr === undefined ? null : Number(budgetStr);
    if (budgetStr !== undefined && !Number.isFinite(budgetUsd)) {
      process.stderr.write(`Invalid --budget-usd value: ${budgetStr}\n`);
      process.exit(2);
    }
    const slugPrefix = getFlag(argv, '--slug-prefix') ?? null;
    const modelsStr = getFlag(argv, '--models');
    const models = modelsStr ? modelsStr.split(',').map(s => s.trim()).filter(Boolean) : DEFAULT_MODEL_PANEL;
    const source = (getFlag(argv, '--source') ?? 'db') as 'db' | 'fs';

    if (!json) {
      process.stderr.write(
        `[eval takes-quality] sampling ${limit} take(s) from ${source}; ` +
        `panel: ${models.join(', ')}; cycles: ${cycles}` +
        (budgetUsd === null ? '' : `; budget: $${budgetUsd.toFixed(2)}`) +
        '\n',
      );
    }

    let result;
    try {
      result = await runEval(engine, { limit, cycles, models, budgetUsd, slugPrefix, source });
    } catch (e) {
      process.stderr.write(`run failed: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    }
    try {
      await writeReceipt(engine, result.receipt);
    } catch (e) {
      process.stderr.write(`receipt-write to DB failed: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    }
    if (json) {
      console.log(JSON.stringify(result.receipt, null, 2));
    } else {
      console.log(`\nverdict: ${result.receipt.verdict}`);
      console.log(`overall: ${result.receipt.overall_score ?? 'n/a'}/10`);
      console.log(`cost:    $${result.receipt.cost_usd.toFixed(4)}`);
      if (result.receipt.verdictMessage) console.log(`note:    ${result.receipt.verdictMessage}`);
      if (result.budgetAborted) console.log(`(budget cap aborted run)`);
    }
    process.exit(verdictExitCode(result.receipt.verdict));
  }

  if (subcmd === 'trend') {
    const limit = parseIntFlag(argv, '--limit', 20);
    const rubricVersion = getFlag(argv, '--rubric-version') ?? undefined;
    const rows: TrendRow[] = await loadTrend(engine, { limit, rubricVersion });
    if (json) {
      console.log(JSON.stringify({ schema_version: 1, rows }, null, 2));
    } else {
      console.log(renderTrendTable(rows));
    }
    return;
  }

  if (subcmd === 'regress') {
    const againstPath = getFlag(argv, '--against');
    if (!againstPath) {
      process.stderr.write('regress: --against <receipt-path> is required\n');
      process.exit(2);
    }
    const threshold = Number(getFlag(argv, '--threshold') ?? '0.5');
    if (!Number.isFinite(threshold)) {
      process.stderr.write(`Invalid --threshold: ${getFlag(argv, '--threshold')}\n`);
      process.exit(2);
    }
    const limit = parseIntFlag(argv, '--limit', 100);
    const cycles = parseIntFlag(argv, '--cycles', process.stdout.isTTY ? 3 : 1);

    const prior = loadReceiptFromDisk(againstPath);
    if (!json) {
      process.stderr.write(`[eval takes-quality regress] running fresh eval to compare against ${againstPath}\n`);
    }
    const result = await runEval(engine, {
      limit,
      cycles,
      models: prior.models, // re-use the same panel for apples-to-apples
      slugPrefix: prior.corpus.slug_prefix,
      source: prior.corpus.source,
    });
    try {
      await writeReceipt(engine, result.receipt);
    } catch {
      // best-effort: do NOT fail the regress comparison just because we
      // couldn't persist this run's receipt
    }
    const delta = compareReceipts(result.receipt, prior, { threshold });
    if (json) {
      console.log(JSON.stringify({ schema_version: 1, current: result.receipt, prior, delta }, null, 2));
    } else {
      console.log(`\n${delta.summary}`);
      if (delta.inputs_differ) {
        console.log('  inputs differ:');
        for (const d of delta.input_diffs ?? []) console.log(`    - ${d}`);
      }
    }
    process.exit(delta.regressed ? 1 : 0);
  }
}

function parseIntFlag(argv: string[], name: string, def: number): number {
  const v = getFlag(argv, name);
  if (v === undefined) return def;
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n < 0) {
    process.stderr.write(`Invalid ${name} value: ${v}\n`);
    process.exit(2);
  }
  return n;
}

function verdictExitCode(verdict: 'pass' | 'fail' | 'inconclusive'): number {
  if (verdict === 'pass') return 0;
  if (verdict === 'fail') return 1;
  return 2;
}
