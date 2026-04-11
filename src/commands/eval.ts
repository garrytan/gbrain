/**
 * gbrain eval — Retrieval Evaluation Command
 *
 * Runs search quality benchmarks against user-defined ground truth (qrels).
 * Supports single-config runs and A/B comparison mode for tuning parameters.
 *
 * Usage:
 *   gbrain eval --qrels <path|json>
 *   gbrain eval --qrels <path> --config-a <path|json> --config-b <path|json>
 *   gbrain eval --qrels <path> --strategy hybrid --rrf-k 30 --k 5
 */

import { readFileSync, existsSync } from 'fs';
import type { BrainEngine } from '../core/engine.ts';
import {
  runEval,
  parseQrels,
  type EvalConfig,
  type EvalReport,
  type QueryResult,
} from '../core/search/eval.ts';

export async function runEvalCommand(engine: BrainEngine, args: string[]): Promise<void> {
  const opts = parseArgs(args);

  if (opts.help) {
    printHelp();
    return;
  }

  if (!opts.qrels) {
    console.error('Error: --qrels <path|json> is required\n');
    printHelp();
    process.exit(1);
  }

  let qrels;
  try {
    qrels = parseQrels(opts.qrels);
  } catch (err: any) {
    console.error(`Error loading qrels: ${err.message}`);
    process.exit(1);
  }

  if (qrels.length === 0) {
    console.error('Error: qrels file contains no queries');
    process.exit(1);
  }

  const k = opts.k ?? 5;
  const configA = buildConfig(opts, 'a');

  if (opts.configB || opts.configBPath) {
    // A/B comparison mode
    const configB = buildConfig(opts, 'b');
    const [reportA, reportB] = await Promise.all([
      runEval(engine, qrels, configA, k),
      runEval(engine, qrels, configB, k),
    ]);
    printABTable(reportA, reportB, k);
  } else {
    // Single-run mode
    const report = await runEval(engine, qrels, configA, k);
    printSingleTable(report);
  }
}

// ─────────────────────────────────────────────────────────────────
// Argument parsing
// ─────────────────────────────────────────────────────────────────

interface ParsedArgs {
  help: boolean;
  qrels?: string;
  configAPath?: string;
  configBPath?: string;
  configB?: EvalConfig;
  strategy?: EvalConfig['strategy'];
  rrfK?: number;
  expand?: boolean;
  dedupCosine?: number;
  dedupTypeRatio?: number;
  dedupMaxPerPage?: number;
  limit?: number;
  k?: number;
}

function parseArgs(args: string[]): ParsedArgs {
  const opts: ParsedArgs = { help: false };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    switch (arg) {
      case '--help': case '-h': opts.help = true; break;
      case '--qrels': opts.qrels = next; i++; break;
      case '--config-a': opts.configAPath = next; i++; break;
      case '--config-b': opts.configBPath = next; i++; break;
      case '--strategy': opts.strategy = next as EvalConfig['strategy']; i++; break;
      case '--rrf-k': opts.rrfK = parseInt(next, 10); i++; break;
      case '--expand': opts.expand = true; break;
      case '--no-expand': opts.expand = false; break;
      case '--dedup-cosine': opts.dedupCosine = parseFloat(next); i++; break;
      case '--dedup-type-ratio': opts.dedupTypeRatio = parseFloat(next); i++; break;
      case '--dedup-max-per-page': opts.dedupMaxPerPage = parseInt(next, 10); i++; break;
      case '--limit': opts.limit = parseInt(next, 10); i++; break;
      case '--k': opts.k = parseInt(next, 10); i++; break;
    }
  }

  return opts;
}

function buildConfig(opts: ParsedArgs, side: 'a' | 'b'): EvalConfig {
  const pathOpt = side === 'a' ? opts.configAPath : opts.configBPath;

  // Start from file or inline JSON if provided
  let base: EvalConfig = {};
  if (pathOpt) {
    base = loadConfigFile(pathOpt);
  }

  // CLI flags override config file (only for side A — side B comes entirely from its config file)
  if (side === 'a') {
    if (opts.strategy !== undefined) base.strategy = opts.strategy;
    if (opts.rrfK !== undefined) base.rrf_k = opts.rrfK;
    if (opts.expand !== undefined) base.expand = opts.expand;
    if (opts.dedupCosine !== undefined) base.dedup_cosine_threshold = opts.dedupCosine;
    if (opts.dedupTypeRatio !== undefined) base.dedup_type_ratio = opts.dedupTypeRatio;
    if (opts.dedupMaxPerPage !== undefined) base.dedup_max_per_page = opts.dedupMaxPerPage;
    if (opts.limit !== undefined) base.limit = opts.limit;

    // Defaults for side A
    if (!base.name) base.name = 'Config A';
    if (!base.strategy) base.strategy = 'hybrid';
  } else {
    if (!base.name) base.name = 'Config B';
    if (!base.strategy) base.strategy = 'hybrid';
  }

  return base;
}

function loadConfigFile(pathOrJson: string): EvalConfig {
  const trimmed = pathOrJson.trimStart();
  if (trimmed.startsWith('{')) {
    return JSON.parse(pathOrJson) as EvalConfig;
  }
  if (!existsSync(pathOrJson)) {
    console.error(`Config file not found: ${pathOrJson}`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(pathOrJson, 'utf-8')) as EvalConfig;
}

// ─────────────────────────────────────────────────────────────────
// Output formatting
// ─────────────────────────────────────────────────────────────────

function printSingleTable(report: EvalReport): void {
  const { config, k, queries } = report;
  const label = config.name ?? config.strategy ?? 'hybrid';

  console.log(`\ngbrain eval — ${queries.length} quer${queries.length === 1 ? 'y' : 'ies'} · strategy: ${label} · k=${k}\n`);

  const COL_QUERY = 36;
  const COL_NUM = 7;
  const header = padR('Query', COL_QUERY) + padL(`P@${k}`, COL_NUM) + padL(`R@${k}`, COL_NUM) + padL('MRR', COL_NUM) + padL(`nDCG@${k}`, COL_NUM);
  const divider = '─'.repeat(header.length);

  console.log(header);
  console.log(divider);

  for (const q of queries) {
    console.log(
      padR(truncate(q.query, COL_QUERY - 1), COL_QUERY) +
      padL(fmt(q.precision_at_k), COL_NUM) +
      padL(fmt(q.recall_at_k), COL_NUM) +
      padL(fmt(q.mrr), COL_NUM) +
      padL(fmt(q.ndcg_at_k), COL_NUM),
    );
  }

  console.log(divider);
  console.log(
    padR('Mean', COL_QUERY) +
    padL(fmt(report.mean_precision), COL_NUM) +
    padL(fmt(report.mean_recall), COL_NUM) +
    padL(fmt(report.mean_mrr), COL_NUM) +
    padL(fmt(report.mean_ndcg), COL_NUM),
  );
  console.log('');
}

function printABTable(reportA: EvalReport, reportB: EvalReport, k: number): void {
  const labelA = reportA.config.name ?? 'Config A';
  const labelB = reportB.config.name ?? 'Config B';
  const n = reportA.queries.length;

  console.log(`\ngbrain eval — ${n} quer${n === 1 ? 'y' : 'ies'} · A/B comparison · k=${k}\n`);

  const COL_QUERY = 34;
  const COL_METRIC = 8;
  const COLS_PER_SIDE = 3; // P@k, MRR, nDCG@k

  // Header line 1: section labels
  const aLabel = ` ${labelA} `.slice(0, COL_METRIC * COLS_PER_SIDE - 2);
  const bLabel = ` ${labelB} `.slice(0, COL_METRIC * COLS_PER_SIDE - 2);
  const line1 =
    ' '.repeat(COL_QUERY) +
    padR(`── ${aLabel} `, COL_METRIC * COLS_PER_SIDE) +
    padR(`── ${bLabel} `, COL_METRIC * COLS_PER_SIDE) +
    `  Δ nDCG`;
  console.log(line1);

  // Header line 2: metric names
  const metricHeader = (suffix: string) =>
    padL(`P@${k}`, COL_METRIC) + padL('MRR', COL_METRIC) + padL(`nDCG@${k}`, COL_METRIC);

  const line2 =
    padR('Query', COL_QUERY) +
    metricHeader('A') +
    '  ' + metricHeader('B') +
    '  ' + padL('Δ nDCG', 10);
  console.log(line2);
  console.log('─'.repeat(line2.length));

  for (let i = 0; i < reportA.queries.length; i++) {
    const qa = reportA.queries[i];
    const qb = reportB.queries[i];
    const delta = qb.ndcg_at_k - qa.ndcg_at_k;
    const deltaStr = delta > 0 ? `+${fmt(delta)}` : fmt(delta);

    console.log(
      padR(truncate(qa.query, COL_QUERY - 1), COL_QUERY) +
      padL(fmt(qa.precision_at_k), COL_METRIC) +
      padL(fmt(qa.mrr), COL_METRIC) +
      padL(fmt(qa.ndcg_at_k), COL_METRIC) +
      '  ' +
      padL(fmt(qb.precision_at_k), COL_METRIC) +
      padL(fmt(qb.mrr), COL_METRIC) +
      padL(fmt(qb.ndcg_at_k), COL_METRIC) +
      '  ' + padL(deltaStr, 10),
    );
  }

  const divider = '─'.repeat(line2.length);
  console.log(divider);

  const meanDelta = reportB.mean_ndcg - reportA.mean_ndcg;
  const meanDeltaStr = (meanDelta > 0 ? '+' : '') + fmt(meanDelta);
  const winner = meanDelta > 0 ? ' ✓ B wins' : meanDelta < 0 ? ' ✓ A wins' : ' tie';

  console.log(
    padR('Mean', COL_QUERY) +
    padL(fmt(reportA.mean_precision), COL_METRIC) +
    padL(fmt(reportA.mean_mrr), COL_METRIC) +
    padL(fmt(reportA.mean_ndcg), COL_METRIC) +
    '  ' +
    padL(fmt(reportB.mean_precision), COL_METRIC) +
    padL(fmt(reportB.mean_mrr), COL_METRIC) +
    padL(fmt(reportB.mean_ndcg), COL_METRIC) +
    '  ' + padL(meanDeltaStr + winner, 10),
  );
  console.log('');
}

// ─────────────────────────────────────────────────────────────────
// Formatting helpers
// ─────────────────────────────────────────────────────────────────

function fmt(n: number): string {
  return n.toFixed(2);
}

function padR(s: string, width: number): string {
  return s.length >= width ? s.slice(0, width) : s + ' '.repeat(width - s.length);
}

function padL(s: string, width: number): string {
  return s.length >= width ? s.slice(0, width) : ' '.repeat(width - s.length) + s;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function printHelp(): void {
  console.log(`
gbrain eval — measure and compare retrieval quality

USAGE
  gbrain eval --qrels <path>
  gbrain eval --qrels <path> --config-a <path> --config-b <path>

OPTIONS
  --qrels <path|json>         Path to qrels JSON file (required)
                              Or inline JSON: '[{"query":"...","relevant":["slug"]}]'
  --config-a <path|json>      Config for strategy A (default: hybrid with defaults)
  --config-b <path|json>      Config for strategy B (triggers A/B mode)
  --strategy <s>              Search strategy: hybrid | keyword | vector
  --rrf-k <n>                 Override RRF K constant (default: 60)
  --expand / --no-expand      Enable/disable multi-query expansion
  --dedup-cosine <f>          Override cosine dedup threshold (default: 0.85)
  --dedup-type-ratio <f>      Override type ratio cap (default: 0.6)
  --dedup-max-per-page <n>    Override max chunks per page (default: 2)
  --limit <n>                 Max results to fetch per query (default: 10)
  --k <n>                     Metric cutoff depth (default: 5)

QRELS FORMAT
  {
    "version": 1,
    "queries": [
      {
        "query": "who founded NovaMind",
        "relevant": ["people/sarah-chen", "companies/novamind"],
        "grades": { "people/sarah-chen": 3, "companies/novamind": 2 }
      }
    ]
  }
  "grades" is optional — enables graded nDCG. Without it, binary relevance is used.

CONFIG FORMAT
  { "name": "rrf-k-30", "strategy": "hybrid", "rrf_k": 30, "expand": false }

EXAMPLES
  gbrain eval --qrels ./my-queries.json
  gbrain eval --qrels ./qrels.json --strategy keyword
  gbrain eval --qrels ./qrels.json --rrf-k 30
  gbrain eval --qrels ./qrels.json --config-a baseline.json --config-b experiment.json
`.trim());
}
