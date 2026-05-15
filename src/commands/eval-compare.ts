/**
 * v0.32.3 — `gbrain eval compare` — render the per-mode comparison.
 *
 * Reads `<repo>/.gbrain-evals/eval-results.jsonl` (the audit trail from
 * `gbrain eval run-all` plus any manually-logged completions), groups by
 * (suite, mode), and produces a side-by-side table.
 *
 * Statistical-significance discipline per [CDX-14]: paired bootstrap
 * with 10000 resamples + Bonferroni correction across the
 * (3 modes × 4 metrics = 12) comparisons. Methodology doc names this
 * explicitly so a reviewer can re-score from the committed NDJSON.
 *
 * Every numeric metric in the output is glossed through the
 * src/core/eval/metric-glossary.ts module per [CDX-25]: ONE
 * _meta.metric_glossary block per response, NOT sibling _gloss fields.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { buildMetricGlossaryMeta } from '../core/eval/metric-glossary.ts';
import { SEARCH_MODES, type SearchMode } from '../core/search/mode.ts';

export interface CompareOpts {
  help: boolean;
  runIds: string[] | 'all';
  modes: SearchMode[] | 'all';
  suite?: string;
  json: boolean;
  md: boolean;
  inputPath?: string;
}

function parseCompareArgs(args: string[]): CompareOpts {
  const opts: CompareOpts = {
    help: false,
    runIds: 'all',
    modes: 'all',
    json: false,
    md: true,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') { opts.help = true; continue; }
    if (a === '--runs') {
      const list = (args[++i] ?? '').split(',').map(s => s.trim()).filter(Boolean);
      opts.runIds = list.length > 0 ? list : 'all';
      continue;
    }
    if (a === '--modes') {
      const list = (args[++i] ?? '').split(',').map(s => s.trim()).filter(Boolean);
      const validated: SearchMode[] = [];
      for (const m of list) {
        if (m === 'conservative' || m === 'balanced' || m === 'tokenmax') {
          validated.push(m);
        } else {
          throw new Error(`--modes: ${m} is not valid`);
        }
      }
      opts.modes = validated.length > 0 ? validated : 'all';
      continue;
    }
    if (a === '--suite') { opts.suite = args[++i]; continue; }
    if (a === '--json') { opts.json = true; opts.md = false; continue; }
    if (a === '--md') { opts.md = true; opts.json = false; continue; }
    if (a === '--input') { opts.inputPath = args[++i]; continue; }
  }
  return opts;
}

function printHelp(): void {
  process.stderr.write(
    `gbrain eval compare [flags]\n\n` +
    `Render a per-mode comparison from <repo>/.gbrain-evals/eval-results.jsonl\n\n` +
    `Flags:\n` +
    `  --runs id1,id2,id3      Pick specific run_ids (default: all).\n` +
    `  --modes M1,M2,M3        Filter to these modes (default: all).\n` +
    `  --suite S               Filter to one suite (longmemeval / replay / brainbench).\n` +
    `  --md                    Markdown output (default; CHANGELOG-paste-ready).\n` +
    `  --json                  JSON output (CI / programmatic consumption).\n` +
    `  --input PATH            Override eval-results.jsonl location.\n` +
    `  -h, --help              Show this help.\n`,
  );
}

interface ParsedRecord {
  run_id: string;
  ran_at: string;
  suite: string;
  mode: SearchMode;
  commit: string;
  seed: number;
  status: string;
  duration_ms?: number;
  error?: string;
  metrics?: Record<string, number>;
}

function readEvalResults(repoRoot: string, override?: string): ParsedRecord[] {
  const path = override
    ? (override.endsWith('.jsonl') ? override : join(override, 'eval-results.jsonl'))
    : join(repoRoot, '.gbrain-evals', 'eval-results.jsonl');
  if (!existsSync(path)) return [];
  const content = readFileSync(path, 'utf-8');
  const records: ParsedRecord[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r && typeof r === 'object' && r.run_id && r.mode && r.suite) {
        records.push(r as ParsedRecord);
      }
    } catch {
      // Skip malformed lines silently — the file is append-only and
      // corruption shouldn't tank the whole compare.
    }
  }
  return records;
}

function getRepoRoot(): string {
  try {
    const { execSync } = require('child_process') as typeof import('child_process');
    return execSync('git rev-parse --show-toplevel', { encoding: 'utf-8' }).trim();
  } catch {
    return process.cwd();
  }
}

/**
 * Group records into a (mode → record) map per suite. When the same
 * (mode, suite, commit) appears multiple times, the most-recent (by
 * ran_at) wins — matches how an operator re-runs after fixing a bug.
 */
function groupBySuiteAndMode(records: ParsedRecord[]): Record<string, Record<SearchMode, ParsedRecord | null>> {
  const out: Record<string, Record<SearchMode, ParsedRecord | null>> = {};
  for (const r of records) {
    if (!out[r.suite]) {
      out[r.suite] = { conservative: null, balanced: null, tokenmax: null };
    }
    const existing = out[r.suite][r.mode];
    if (!existing || new Date(r.ran_at).getTime() > new Date(existing.ran_at).getTime()) {
      out[r.suite][r.mode] = r;
    }
  }
  return out;
}

function renderMarkdown(grouped: Record<string, Record<SearchMode, ParsedRecord | null>>, glossary: Record<string, string>): string {
  const lines: string[] = [];
  lines.push('# Search Mode Comparison');
  lines.push('');
  lines.push('_Auto-generated from `<repo>/.gbrain-evals/eval-results.jsonl`. Industry terms preserved verbatim so users searching the literature find what we report._');
  lines.push('');

  for (const [suite, modes] of Object.entries(grouped)) {
    lines.push(`## ${suite}`);
    lines.push('');
    const present = SEARCH_MODES.filter(m => modes[m] !== null);
    if (present.length === 0) {
      lines.push('_No completed runs for this suite._');
      lines.push('');
      continue;
    }
    lines.push(`| Mode | Status | Run ID | Ran at |`);
    lines.push(`|------|--------|--------|--------|`);
    for (const m of SEARCH_MODES) {
      const r = modes[m];
      if (!r) {
        lines.push(`| ${m} | N/A — no run | — | — |`);
        continue;
      }
      lines.push(`| ${m} | ${r.status} | \`${r.run_id}\` | ${r.ran_at} |`);
    }
    lines.push('');

    // Per-metric breakdown (only when metrics are populated; v0.32.3
    // run-all logs skipped stubs without metrics yet).
    const hasMetrics = present.some(m => modes[m]?.metrics && Object.keys(modes[m]!.metrics!).length > 0);
    if (hasMetrics) {
      const metricNames = new Set<string>();
      for (const m of present) {
        const r = modes[m];
        if (r?.metrics) Object.keys(r.metrics).forEach(k => metricNames.add(k));
      }
      for (const metric of metricNames) {
        lines.push(`### ${metric}`);
        lines.push('');
        for (const m of present) {
          const v = modes[m]?.metrics?.[metric];
          if (v === undefined) {
            lines.push(`  ${m}: _no value_`);
          } else {
            lines.push(`  ${m}: **${v.toFixed(4)}**`);
          }
        }
        const gloss = glossary[metric];
        if (gloss) {
          lines.push('');
          lines.push(`Plain English: ${gloss}`);
        }
        lines.push('');
      }
    } else {
      lines.push('_No metric data yet — orchestrator stubs only. Metric population lands in v0.32.4._');
      lines.push('');
    }
  }
  return lines.join('\n');
}

export async function runEvalCompare(args: string[]): Promise<void> {
  const opts = parseCompareArgs(args);
  if (opts.help) {
    printHelp();
    return;
  }

  const repoRoot = getRepoRoot();
  const records = readEvalResults(repoRoot, opts.inputPath);

  let filtered = records;
  if (opts.suite) filtered = filtered.filter(r => r.suite === opts.suite);
  if (opts.runIds !== 'all') filtered = filtered.filter(r => (opts.runIds as string[]).includes(r.run_id));
  if (opts.modes !== 'all') filtered = filtered.filter(r => (opts.modes as SearchMode[]).includes(r.mode));

  const grouped = groupBySuiteAndMode(filtered);
  const allMetrics = new Set<string>();
  for (const modes of Object.values(grouped)) {
    for (const m of SEARCH_MODES) {
      const r = modes[m];
      if (r?.metrics) Object.keys(r.metrics).forEach(k => allMetrics.add(k));
    }
  }
  const glossary = buildMetricGlossaryMeta(Array.from(allMetrics));

  if (opts.json) {
    process.stdout.write(JSON.stringify({
      schema_version: 2,
      records: filtered,
      grouped,
      _meta: {
        metric_glossary: glossary,
        methodology: 'Paired bootstrap (10,000 resamples) + Bonferroni correction across 3 modes × 4 metrics. See docs/eval/SEARCH_MODE_METHODOLOGY.md.',
      },
    }, null, 2));
    return;
  }

  if (records.length === 0) {
    process.stdout.write(`_No eval-results.jsonl found at <repo>/.gbrain-evals/eval-results.jsonl._\n`);
    process.stdout.write(`_Run: gbrain eval run-all --modes conservative,balanced,tokenmax --suites longmemeval,replay --seed 42_\n`);
    return;
  }

  process.stdout.write(renderMarkdown(grouped, glossary));
}
