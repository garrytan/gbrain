/**
 * v0.32.3 — `gbrain eval compare` — render the per-mode comparison.
 *
 * Reads `<repo>/.gbrain-evals/eval-results.jsonl` (the audit trail from
 * `gbrain eval run-all` plus any manually-logged completions), groups by
 * (suite, mode), and produces a side-by-side table.
 *
 * Statistics are computed only from per-query rows. A run record that
 * points at its per-question output (`params.output`, written by
 * `gbrain eval longmemeval --record --output`) contributes rows; pairs of
 * runs are joined on question_id and compared with a paired cluster
 * bootstrap (95% CI), a two-sided sign-flip randomization p-value, and Holm
 * correction across every comparison in the report
 * (src/core/eval/paired-bootstrap.ts). When no per-query rows are
 * available the report says it is aggregate-only and computes nothing.
 *
 * Every numeric metric in the output is glossed through the
 * src/core/eval/metric-glossary.ts module per [CDX-25]: ONE
 * _meta.metric_glossary block per response, NOT sibling _gloss fields.
 */

import { readFileSync, existsSync, realpathSync } from 'fs';
import { isAbsolute, join, relative, sep } from 'path';
import { buildMetricGlossaryMeta } from '../core/eval/metric-glossary.ts';
import { holmAdjusted, pairedClusterStatistics } from '../core/eval/paired-bootstrap.ts';
import { SEARCH_MODES, type SearchMode } from '../core/search/mode.ts';

export interface CompareOpts {
  help: boolean;
  runIds: string[] | 'all';
  modes: SearchMode[] | 'all';
  suite?: string;
  json: boolean;
  md: boolean;
  inputPath?: string;
  baseline?: string;
  candidate?: string;
  draws: number;
  seed: number;
}

function parseCompareArgs(args: string[]): CompareOpts {
  const opts: CompareOpts = {
    help: false,
    runIds: 'all',
    modes: 'all',
    json: false,
    md: true,
    draws: 10_000,
    seed: 42,
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
    if (a === '--baseline') { opts.baseline = args[++i]; continue; }
    if (a === '--candidate') { opts.candidate = args[++i]; continue; }
    if (a === '--draws' || a === '--seed') {
      const v = Number(args[++i]);
      if (!Number.isInteger(v) || v < (a === '--draws' ? 1000 : 0)) throw new Error(`${a}: expected an integer${a === '--draws' ? ' >= 1000' : ''}`);
      if (a === '--draws') opts.draws = v; else opts.seed = v;
      continue;
    }
  }
  if ((opts.baseline === undefined) !== (opts.candidate === undefined)) throw new Error('--baseline and --candidate go together');
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
    `  --baseline RUN_ID       Compare exactly this run ...\n` +
    `  --candidate RUN_ID      ... against this one (default: every mode pair).\n` +
    `  --draws N               Bootstrap resamples (default 10000).\n` +
    `  --seed N                Resampling seed (default 42).\n\n` +
    `Paired statistics need per-query rows: a run record whose params.output\n` +
    `names its per-question JSONL. Without them the report is aggregate-only.\n` +
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
  params?: Record<string, unknown>;
}

type QueryRow = Record<string, unknown>;

/** Per-query metrics read from per-question rows, named as in the glossary. */
const PER_QUERY_METRICS: Array<{ name: string; value: (row: QueryRow) => number | undefined }> = [
  { name: 'recall_all@k', value: r => typeof r.recall_all_hit === 'boolean' ? Number(r.recall_all_hit) : undefined },
  { name: 'recall_any@k', value: r => typeof r.recall_any_hit === 'boolean' ? Number(r.recall_any_hit) : undefined },
  { name: 'qa_accuracy', value: r => typeof r.judge_correct === 'boolean' && typeof r.judge_error !== 'string' ? Number(r.judge_correct) : undefined },
];

export interface PairedComparison {
  suite: string;
  baseline_run: string;
  candidate_run: string;
  baseline_mode: string;
  candidate_mode: string;
  metric: string;
  n: number;
  clusters: number;
  baseline_mean: number;
  candidate_mean: number;
  delta: number;
  ci95: [number, number];
  p_value: number;
  holm_p_value: number;
  wins: number;
  losses: number;
  ties: number;
  significant: boolean;
}

/**
 * `candidate` resolved against `root`, following symlinks, or null when it
 * lands outside the root (through `..`, an absolute path, or a symlink).
 */
export function pathWithinRoot(root: string, candidate: string): string | null {
  const base = realpathSync(root);
  const target = isAbsolute(candidate) ? candidate : `${base}${sep}${candidate}`;
  const real = existsSync(target) ? realpathSync(target) : target;
  // relative() normalizes `..` segments of a path that does not exist yet.
  const rel = relative(base, real);
  return rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) ? null : real;
}

/** Per-question rows of a run (last row per question_id), or why there are none. */
function readPerQueryRows(record: ParsedRecord, repoRoot: string): { rows: Map<string, QueryRow> } | { reason: string } {
  const output = record.params?.output;
  if (typeof output !== 'string' || !output) return { reason: 'record has no params.output per-query file' };
  const path = pathWithinRoot(repoRoot, output);
  if (!path) return { reason: `refused per-query file outside the repository root (${repoRoot}): ${output}` };
  if (!existsSync(path)) return { reason: `per-query file not found: ${output}` };
  const rows = new Map<string, QueryRow>();
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as QueryRow;
      if (row && typeof row.question_id === 'string' && row.kind !== 'by_type_summary') rows.set(row.question_id, row);
    } catch {
      // Same tolerance as the run ledger: a torn line never tanks the report.
    }
  }
  return rows.size ? { rows } : { reason: `per-query file has no question rows: ${output}` };
}

/**
 * Paired comparisons for each (baseline, candidate) run pair: rows joined on
 * question_id, one comparison per metric both rows carry, questions as
 * clusters, Holm across the whole family.
 */
export function pairedComparisons(
  pairs: Array<[ParsedRecord, ParsedRecord]>,
  repoRoot: string,
  opts: { draws: number; seed: number },
): { comparisons: PairedComparison[]; unavailable: Array<{ run_id: string; reason: string }> } {
  const unavailable = new Map<string, string>();
  const cache = new Map<string, Map<string, QueryRow> | null>();
  const rowsOf = (r: ParsedRecord) => {
    if (!cache.has(r.run_id)) {
      const loaded = readPerQueryRows(r, repoRoot);
      if ('reason' in loaded) unavailable.set(r.run_id, loaded.reason);
      cache.set(r.run_id, 'rows' in loaded ? loaded.rows : null);
    }
    return cache.get(r.run_id) ?? null;
  };
  const raw: Array<Omit<PairedComparison, 'holm_p_value' | 'significant'>> = [];
  for (const [b, c] of pairs) {
    const bRows = rowsOf(b), cRows = rowsOf(c);
    if (!bRows || !cRows) continue;
    for (const metric of PER_QUERY_METRICS) {
      const observations = [...bRows].flatMap(([qid, row]) => {
        const other = cRows.get(qid);
        const bv = metric.value(row), cv = other ? metric.value(other) : undefined;
        return bv === undefined || cv === undefined ? [] : [{ cluster: qid, baseline: bv, candidate: cv }];
      });
      if (!observations.length) continue;
      const st = pairedClusterStatistics(observations, opts);
      raw.push({
        suite: c.suite, baseline_run: b.run_id, candidate_run: c.run_id, baseline_mode: b.mode, candidate_mode: c.mode,
        metric: metric.name, n: st.n, clusters: st.clusters, baseline_mean: st.baseline_mean, candidate_mean: st.candidate_mean,
        delta: st.delta, ci95: [st.lower95, st.upper95], p_value: st.p_value, wins: st.wins, losses: st.losses, ties: st.ties,
      });
    }
  }
  const holm = holmAdjusted(raw.map(r => r.p_value));
  const comparisons = raw.map((r, i) => ({
    ...r,
    holm_p_value: holm[i],
    significant: holm[i] <= 0.05 && (r.ci95[0] > 0 || r.ci95[1] < 0),
  }));
  return { comparisons, unavailable: [...unavailable].map(([run_id, reason]) => ({ run_id, reason })) };
}

function methodologyText(comparisons: PairedComparison[], opts: { draws: number; seed: number }): string {
  if (!comparisons.length) {
    return 'Aggregate-only: no per-query rows were available for the selected runs, so no confidence intervals or significance tests were computed. Aggregate metrics are shown as recorded.';
  }
  return `Paired cluster bootstrap over per-query rows joined on question_id (${opts.draws} resamples, seed ${opts.seed}; clusters = questions); `
    + 'two-sided sign-flip randomization p-values (exact at 16 or fewer clusters); '
    + `Holm correction across the ${comparisons.length} comparison(s) in this report. A difference is significant only when the Holm p-value is at most 0.05 and the 95% CI excludes 0. `
    + 'See docs/eval/SEARCH_MODE_METHODOLOGY.md.';
}

function fmt(x: number): string {
  return Number.isFinite(x) ? x.toFixed(4) : String(x);
}

function renderPaired(comparisons: PairedComparison[], unavailable: Array<{ run_id: string; reason: string }>, methodology: string): string {
  const lines = ['## Paired comparisons', ''];
  if (comparisons.length) {
    lines.push('| Suite | Baseline → Candidate | Metric | Pairs (clusters) | Baseline | Candidate | Δ | 95% CI | p | Holm p | Wins / losses / ties | Verdict |');
    lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const c of comparisons) {
      lines.push(`| ${c.suite} | \`${c.baseline_run}\` (${c.baseline_mode}) → \`${c.candidate_run}\` (${c.candidate_mode}) | ${c.metric} | ${c.n} (${c.clusters}) | ${fmt(c.baseline_mean)} | ${fmt(c.candidate_mean)} | ${fmt(c.delta)} | [${fmt(c.ci95[0])}, ${fmt(c.ci95[1])}] | ${fmt(c.p_value)} | ${fmt(c.holm_p_value)} | ${c.wins} / ${c.losses} / ${c.ties} | ${c.significant ? 'significant' : 'not significant'} |`);
    }
    lines.push('');
  }
  for (const u of unavailable) lines.push(`- \`${u.run_id}\`: ${u.reason}`);
  if (unavailable.length) lines.push('');
  lines.push(`_${methodology}_`, '');
  return lines.join('\n');
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

  let runPairs: Array<[ParsedRecord, ParsedRecord]> = [];
  if (opts.baseline && opts.candidate) {
    const find = (id: string) => records.find(r => r.run_id === id);
    const b = find(opts.baseline), c = find(opts.candidate);
    if (!b || !c) throw new Error(`run not found in eval-results.jsonl: ${!b ? opts.baseline : opts.candidate}`);
    runPairs = [[b, c]];
  } else {
    for (const modes of Object.values(grouped)) {
      const present = SEARCH_MODES.map(m => modes[m]).filter((r): r is ParsedRecord => r !== null);
      for (let i = 0; i < present.length; i++) for (let j = i + 1; j < present.length; j++) runPairs.push([present[i], present[j]]);
    }
  }
  const { comparisons, unavailable } = pairedComparisons(runPairs, repoRoot, opts);
  comparisons.forEach(c => allMetrics.add(c.metric));
  if (comparisons.length) ['p_value', 'confidence_interval'].forEach(k => allMetrics.add(k));
  const glossary = buildMetricGlossaryMeta(Array.from(allMetrics));
  const methodology = methodologyText(comparisons, opts);

  if (opts.json) {
    process.stdout.write(JSON.stringify({
      schema_version: 2,
      records: filtered,
      grouped,
      paired: comparisons,
      paired_unavailable: unavailable,
      _meta: {
        metric_glossary: glossary,
        methodology,
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
  process.stdout.write(renderPaired(comparisons, unavailable, methodology));
}
