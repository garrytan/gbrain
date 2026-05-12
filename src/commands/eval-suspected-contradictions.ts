/**
 * `gbrain eval suspected-contradictions` — v0.33.0 contradiction probe CLI.
 *
 * Three sub-subcommands:
 *   - run (default): execute one probe pass; --queries-file / --query /
 *     --from-capture. Cost-capped via --budget-usd; --yes overrides
 *     pre-flight refusal. Writes a row to eval_contradictions_runs on
 *     success, prints JSON to stdout when --json, human summary to stderr.
 *   - trend: read eval_contradictions_runs and render the ASCII chart.
 *   - review: surface findings from the most recent run, optionally
 *     filtered by severity. Reuses the M7 resolution proposals.
 *
 * Output discipline:
 *   - stderr: human-readable summary
 *   - stdout: JSON (when --json is set), reserved for piping
 *   - exit codes: 0 success, 1 over-budget without --yes, 2 mutually-
 *     exclusive sources OR empty capture table with hint
 */

import { readFileSync } from 'node:fs';
import type { BrainEngine } from '../core/engine.ts';
import {
  PreFlightBudgetError,
  runContradictionProbe,
} from '../core/eval-contradictions/runner.ts';
import { loadTrend, renderTrendChart, writeRunRow } from '../core/eval-contradictions/trends.ts';
import {
  bucketBySeverity,
  compareSeverityDesc,
} from '../core/eval-contradictions/severity-classify.ts';
import type {
  ContradictionFinding,
  Severity,
} from '../core/eval-contradictions/types.ts';

interface ParsedFlags {
  sub: 'run' | 'trend' | 'review';
  // run flags
  queriesFile?: string;
  query?: string;
  fromCapture?: boolean;
  topK: number;
  judge: string;
  limit?: number;
  budgetUsd: number;
  output?: string;
  maxPairChars: number;
  sampling: 'deterministic' | 'score-first';
  noCache: boolean;
  refreshCache: boolean;
  json: boolean;
  yes: boolean;
  // trend flags
  days: number;
  // review flags
  severity?: Severity;
  since?: string;
  // help
  help: boolean;
}

function parseFlags(args: string[]): ParsedFlags {
  // Sub-subcommand: first positional that doesn't start with --
  let sub: 'run' | 'trend' | 'review' = 'run';
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (i === 0 && !a.startsWith('--')) {
      if (a === 'run' || a === 'trend' || a === 'review') {
        sub = a;
        continue;
      }
    }
    rest.push(a);
  }
  const isTty = process.stdout.isTTY === true;
  const f: ParsedFlags = {
    sub,
    topK: 5,
    judge: 'anthropic:claude-haiku-4-5',
    budgetUsd: isTty ? 5 : 1,
    maxPairChars: 1500,
    sampling: 'deterministic',
    noCache: false,
    refreshCache: false,
    json: false,
    yes: false,
    days: 30,
    help: false,
  };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    const next = (): string => {
      const v = rest[++i];
      if (v === undefined) throw new Error(`flag ${arg} requires a value`);
      return v;
    };
    if (arg === '--help' || arg === '-h') f.help = true;
    else if (arg === '--queries-file') f.queriesFile = next();
    else if (arg === '--query') f.query = next();
    else if (arg === '--from-capture') f.fromCapture = true;
    else if (arg === '--top-k') f.topK = Number.parseInt(next(), 10);
    else if (arg === '--judge') f.judge = next();
    else if (arg === '--limit') f.limit = Number.parseInt(next(), 10);
    else if (arg === '--budget-usd') f.budgetUsd = Number.parseFloat(next());
    else if (arg === '--output') f.output = next();
    else if (arg === '--max-pair-chars') f.maxPairChars = Number.parseInt(next(), 10);
    else if (arg === '--sampling') {
      const v = next();
      if (v !== 'deterministic' && v !== 'score-first') {
        throw new Error('--sampling must be deterministic|score-first');
      }
      f.sampling = v;
    }
    else if (arg === '--no-cache') f.noCache = true;
    else if (arg === '--refresh-cache') f.refreshCache = true;
    else if (arg === '--json') f.json = true;
    else if (arg === '--yes' || arg === '-y') f.yes = true;
    else if (arg === '--days') f.days = Number.parseInt(next(), 10);
    else if (arg === '--severity') {
      const v = next();
      if (v !== 'low' && v !== 'medium' && v !== 'high') {
        throw new Error('--severity must be low|medium|high');
      }
      f.severity = v;
    }
    else if (arg === '--since') f.since = next();
    else {
      throw new Error(`unknown flag: ${arg}`);
    }
  }
  return f;
}

function printHelp(): void {
  console.error(`Usage:
  gbrain eval suspected-contradictions [run]
    [--queries-file FILE.jsonl | --query "..." | --from-capture]
    [--top-k N=5] [--judge MODEL=claude-haiku-4-5]
    [--limit N] [--budget-usd N] [--output FILE]
    [--max-pair-chars N=1500] [--sampling deterministic|score-first]
    [--no-cache] [--refresh-cache] [--json] [--yes]

  gbrain eval suspected-contradictions trend [--days N=30] [--json]

  gbrain eval suspected-contradictions review
    [--severity low|medium|high] [--since YYYY-MM-DD]

The probe samples top-K retrieval pairs and asks an LLM judge whether
any pair contradicts on a factual claim relevant to the query. Outputs
JSON (stable schema_version: 1) and a human summary.
`);
}

/** Read --queries-file as JSONL or plain-text-one-query-per-line. */
function readQueriesFile(path: string): string[] {
  const raw = readFileSync(path, 'utf8');
  const queries: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed) as { query?: string };
        if (typeof parsed.query === 'string' && parsed.query.length > 0) {
          queries.push(parsed.query);
        }
      } catch {
        // ignore malformed line
      }
    } else {
      queries.push(trimmed);
    }
  }
  return queries;
}

/** Detect non-empty eval_candidates; exit 2 with hint when empty (A4). */
async function loadFromCapture(engine: BrainEngine, limit?: number): Promise<string[]> {
  const rows = await engine.executeRaw<{ query: string }>(
    `SELECT query FROM eval_candidates WHERE query IS NOT NULL ORDER BY id DESC LIMIT $1`,
    [limit ?? 100],
  );
  if (!rows || rows.length === 0) {
    console.error(
      `--from-capture: no rows in eval_candidates. Captures are off by default in v0.25.0+.\n` +
        `Enable with:\n` +
        `  export GBRAIN_CONTRIBUTOR_MODE=1\n` +
        `or set 'eval.capture: true' in your gbrain config. Re-run queries to populate, then try again.`,
    );
    process.exit(2);
  }
  return rows.map((r) => r.query);
}

function exclusiveOneOf(...flags: Array<unknown>): boolean {
  let count = 0;
  for (const f of flags) if (f) count++;
  return count === 1;
}

async function runRun(engine: BrainEngine, f: ParsedFlags): Promise<void> {
  if (!exclusiveOneOf(f.queriesFile, f.query, f.fromCapture)) {
    console.error(
      `Must pass exactly one of: --queries-file FILE, --query "...", --from-capture.`,
    );
    process.exit(2);
  }

  let queries: string[] = [];
  if (f.queriesFile) queries = readQueriesFile(f.queriesFile);
  else if (f.query) queries = [f.query];
  else if (f.fromCapture) queries = await loadFromCapture(engine, f.limit);

  if (typeof f.limit === 'number' && f.limit > 0) {
    queries = queries.slice(0, f.limit);
  }

  if (queries.length === 0) {
    console.error('No queries to evaluate.');
    process.exit(1);
  }

  console.error(
    `Contradiction probe: ${queries.length} queries, top-${f.topK}, judge=${f.judge}, budget=$${f.budgetUsd.toFixed(2)}.`,
  );

  // Refresh-cache: sweep before run so the cache misses on this pass.
  if (f.refreshCache) {
    const swept = await engine.sweepContradictionCache();
    console.error(`Swept ${swept} expired cache rows before run.`);
  }

  try {
    const out = await runContradictionProbe({
      engine,
      queries,
      judgeModel: f.judge,
      topK: f.topK,
      sampling: f.sampling,
      budgetUsd: f.budgetUsd,
      yesOverride: f.yes,
      maxPairChars: f.maxPairChars,
      noCache: f.noCache,
    });

    // Persist to runs table (M5).
    await writeRunRow(engine, out.report, out.report.duration_ms);

    // Human summary.
    const r = out.report;
    const pct = (n: number) => (n * 100).toFixed(0);
    const lines: string[] = [];
    lines.push(``);
    lines.push(`Results: ${r.queries_evaluated} queries, top-${r.top_k} each, judge=${r.judge_model}`);
    lines.push(`  Queries with >=1 contradiction: ${r.queries_with_contradiction} / ${r.queries_evaluated} (${pct(r.queries_with_contradiction / Math.max(1, r.queries_evaluated))}%)`);
    lines.push(`  Wilson CI 95%: ${pct(r.calibration.wilson_ci_95.lower)}–${pct(r.calibration.wilson_ci_95.upper)}%`);
    if (r.calibration.small_sample_note) {
      lines.push(`  Note: ${r.calibration.small_sample_note}`);
    }
    lines.push(`  Total contradictions flagged: ${r.total_contradictions_flagged}`);
    lines.push(`  Judge errors: ${r.judge_errors.total} (parse_fail=${r.judge_errors.parse_fail} timeout=${r.judge_errors.timeout} http_5xx=${r.judge_errors.http_5xx} refusal=${r.judge_errors.refusal})`);
    lines.push(`  Cache: ${r.cache.hits} hits / ${r.cache.misses} misses (${pct(r.cache.hit_rate)}% hit-rate)`);
    lines.push(`  Source-tier breakdown:`);
    lines.push(`    curated_vs_curated: ${r.source_tier_breakdown.curated_vs_curated}`);
    lines.push(`    curated_vs_bulk:    ${r.source_tier_breakdown.curated_vs_bulk}`);
    lines.push(`    bulk_vs_bulk:       ${r.source_tier_breakdown.bulk_vs_bulk}`);
    lines.push(`    other:              ${r.source_tier_breakdown.other}`);
    lines.push(`  Cost: $${r.cost_usd.total.toFixed(4)} (judge $${r.cost_usd.judge.toFixed(4)} + embedding $${r.cost_usd.embedding.toFixed(6)})`);
    lines.push(`  Duration: ${r.duration_ms}ms`);
    if (r.hot_pages.length > 0) {
      lines.push(`  Hot pages:`);
      for (const p of r.hot_pages.slice(0, 5)) {
        lines.push(`    ${p.slug} (${p.appearances}, max ${p.max_severity})`);
      }
    }
    if (out.capHitMidRun) {
      lines.push(`  *** budget cap hit mid-run; report is partial ***`);
    }
    console.error(lines.join('\n'));

    if (f.output) {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(f.output, JSON.stringify(r, null, 2));
      console.error(`Details: ${f.output}`);
    }

    if (f.json) {
      console.log(JSON.stringify(r, null, 2));
    }

    if (out.capHitMidRun && !f.yes) {
      // Cap was hit; we already wrote a partial. Exit non-zero to signal.
      process.exit(1);
    }
  } catch (err) {
    if (err instanceof PreFlightBudgetError) {
      console.error(`Pre-flight refused: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

async function runTrend(engine: BrainEngine, f: ParsedFlags): Promise<void> {
  const rows = await loadTrend(engine, f.days);
  if (f.json) {
    console.log(JSON.stringify({ schema_version: 1, days: f.days, rows }, null, 2));
    return;
  }
  console.error(renderTrendChart(rows));
}

async function runReview(engine: BrainEngine, f: ParsedFlags): Promise<void> {
  const rows = await loadTrend(engine, 90);
  if (rows.length === 0) {
    console.error('No probe runs in the last 90 days. Run the probe first.');
    process.exit(1);
  }
  const latest = rows[0];
  const report = latest.report_json;
  if (!report || !report.per_query) {
    console.error('Latest run has no findings to review.');
    return;
  }
  const allFindings: ContradictionFinding[] = report.per_query.flatMap((q) => q.contradictions);
  const filtered = f.severity ? allFindings.filter((c) => c.severity === f.severity) : allFindings;
  if (filtered.length === 0) {
    console.error(`No findings${f.severity ? ` at severity=${f.severity}` : ''}.`);
    return;
  }
  filtered.sort((a, b) => compareSeverityDesc(a.severity, b.severity));
  const buckets = bucketBySeverity(filtered);
  for (const sev of ['high', 'medium', 'low'] as const) {
    const items = buckets[sev];
    if (items.length === 0) continue;
    console.error(`\n${sev.toUpperCase()} severity (${items.length}):`);
    for (const item of items) {
      console.error(`  - ${item.a.slug} vs ${item.b.slug}`);
      if (item.axis) console.error(`    axis: ${item.axis}`);
      console.error(`    → ${item.resolution_command}`);
    }
  }
}

export async function runEvalSuspectedContradictions(
  engine: BrainEngine,
  args: string[],
): Promise<void> {
  let flags: ParsedFlags;
  try {
    flags = parseFlags(args);
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    printHelp();
    process.exit(2);
  }
  if (flags.help) {
    printHelp();
    return;
  }
  if (flags.sub === 'run') return runRun(engine, flags);
  if (flags.sub === 'trend') return runTrend(engine, flags);
  if (flags.sub === 'review') return runReview(engine, flags);
}
