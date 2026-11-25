/**
 * Swap readiness criterion 8 from the engine-bench speed receipt (docs/designs/RUST_ENGINE.md criterion 8, D14, D17, D23).
 *
 * `classifyBench` is the one evaluator: pure, shared by `gbrain engine shadow status`, the report and the import
 * command. It applies gbrain-evals' own rule (`eval/runner/engine-bench/eval-gates.ts` `criterion8()`) to every
 * expected operation class and quantile against each TypeScript engine, and the same direction rule to every other
 * metric. The result fills the readiness `bench` fields; `src/core/engine-swap/readiness.ts` reads them and does not
 * change. Speed is reported and never gates (D23): nothing here can turn the swap verdict.
 *
 * Two sources stay apart. `bench_corpus` is the engine-bench receipt, a fixed corpus and not this brain.
 * `owner_brain` is `gbrain engine shadow bench` replay on this brain, which does not exist yet, so it reads "not measured".
 * `filtered_vector_margin_met` is never written: the D14 margin is not set.
 */
import { MIN_BENCH_PAIRS } from '../core/engine-swap/readiness.ts';
import { readBoundedFile } from './bench-file.ts';
import {
  benchSummaryPath, ENGINE_LABEL, EXPECTED_METRICS, EXPECTED_OPS, MAX_SUMMARY_BYTES, QUANTILES, TS_ENGINES, validateSummary,
  type BenchPair, type BenchSummary, type Direction, type MetricEntry, type MetricSample, type TsEngine,
} from './bench-receipt.ts';
import { readEpoch } from './evidence-epoch.ts';

export const FILTERED_VECTOR_MARGIN = 'D14 margin not set';
export const OWNER_BRAIN_NOT_BUILT = 'gbrain engine shadow bench (paired replay on this brain) is not built';
export const LOSS_PREFIX = 'bench corpus: ';
const NO_RECEIPT = 'no receipt imported (gbrain engine shadow bench --import <receipt.json> loads an engine-bench speed receipt)';

export type RowStatus = 'better' | 'worse' | 'not_shown' | 'too_few_pairs' | 'missing' | 'not_measured';
export interface BenchRow {
  kind: 'latency' | 'metric';
  name: string;
  against: TsEngine;
  status: RowStatus;
  n_pairs: number | null;
  ratio: number | null;
  ci95: [number, number] | null;
  direction: Direction;
  sample: MetricSample | null;
  reason: string | null;
}
export type Match = 'same' | 'differs' | 'unknown';
export type CorpusSource =
  | { state: 'not_measured' | 'unreadable'; reason: string }
  | {
    state: 'measured'; primary_engine: string | null; imported_at: string; source_file: string; receipt_sha256: string; receipt: BenchSummary['receipt'];
    build_match: { commit: Match; addon: Match; target: Match; epoch_id: string | null }; rows: BenchRow[];
  };
export interface BenchStatus {
  pairs?: number;
  rust_no_worse?: boolean;
  losses?: string[];
  filtered_vector_margin: typeof FILTERED_VECTOR_MARGIN;
  sources: { bench_corpus: CorpusSource; owner_brain: { state: 'not_measured'; reason: string } };
}

// ─── classification ─────────────────────────────────────────────────

function direct(dir: Direction, ratio: number, ci: [number, number] | null): 'better' | 'worse' | 'not_shown' {
  const lower = dir === 'lower_is_better';
  const worse = ci ? (lower ? ci[0] > 1 : ci[1] < 1) : (lower ? ratio > 1 : ratio < 1);
  const better = ci ? (lower ? ci[1] < 1 : ci[0] > 1) : (lower ? ratio < 1 : ratio > 1);
  return worse ? 'worse' : better ? 'better' : 'not_shown';
}

function latencyRow(pair: BenchPair | undefined, against: TsEngine, op: string, q: (typeof QUANTILES)[number]): BenchRow {
  const base = { kind: 'latency' as const, name: `${op} ${q}`, against, direction: 'lower_is_better' as const, sample: null };
  const gone = (reason: string): BenchRow => ({ ...base, status: 'missing', n_pairs: null, ratio: null, ci95: null, reason });
  if (!pair) return gone(`no Rust pair against ${ENGINE_LABEL[against]} in the receipt`);
  if (pair.missing[op]) return gone(`Rust refused: ${pair.missing[op]}`);
  const l = pair.latency[op];
  if (!l) return gone('absent from the receipt');
  const r = l[`${q}_ratio`];
  const few = l.n < MIN_BENCH_PAIRS || !r.ci95;
  const reason = l.n < MIN_BENCH_PAIRS ? `${l.n} pairs (needs ${MIN_BENCH_PAIRS})` : `no interval over ${l.n} pairs`;
  return { ...base, n_pairs: l.n, ratio: r.ratio, ci95: r.ci95, status: few ? 'too_few_pairs' : direct('lower_is_better', r.ratio as number, r.ci95), reason: few ? reason : null };
}

function metricRow(pair: BenchPair | undefined, against: TsEngine, name: string, dir: Direction): BenchRow {
  const base = { kind: 'metric' as const, name, against, n_pairs: null, ratio: null, ci95: null, direction: dir, sample: null };
  const gone = (reason: string): BenchRow => ({ ...base, status: 'not_measured', reason });
  if (!pair) return gone(`no Rust pair against ${ENGINE_LABEL[against]} in the receipt`);
  const m = pair.metrics.find((x) => x.metric === name);
  if (!m) return gone('absent from the receipt');
  if (m.status === 'missing') return { ...gone('the receipt marks it missing: Rust did not produce it'), direction: m.direction, sample: m.sample };
  const sm = m.sample;
  if (sm && ((sm.kind === 'throughput_reps' && sm.reps === 0) || (sm.kind === 'cold_starts' && (sm.rust === 0 || sm.reference === 0)))) return { ...gone('the receipt records zero samples'), direction: m.direction, sample: sm };
  return { ...base, direction: m.direction, ratio: m.ratio, ci95: m.ci95, sample: m.sample, status: direct(m.direction, m.ratio as number, m.ci95), reason: m.ci95 ? null : 'point estimate no interval' };
}

const fmt = (x: number): string => (x < 100 ? x.toFixed(3) : x.toFixed(1));
const interval = (ci: [number, number]): string => `95% CI ${fmt(ci[0])} to ${fmt(ci[1])}`;

function sampleText(s: MetricSample | null, other: string): string {
  if (!s) return 'sample count not recorded';
  if (s.kind === 'throughput_reps') return `over ${s.reps} reps`;
  if (s.kind === 'cold_starts') return `over ${s.rust ?? 'an unrecorded number of'} Rust and ${s.reference ?? 'an unrecorded number of'} ${other} starts`;
  return 'single point';
}

/** One loss line per worse row, then one per row that is not measured. No comma or semicolon: readiness joins losses with both. */
function lossText(r: BenchRow): string {
  const label = ENGINE_LABEL[r.against];
  if (r.status === 'worse') {
    const detail = r.kind === 'latency' ? `${interval(r.ci95!)} over ${r.n_pairs} pairs`
      : r.ci95 ? `${interval(r.ci95)} ${r.sample ? sampleText(r.sample, label) : 'with sample count not recorded'}` : 'point estimate no interval';
    return `${LOSS_PREFIX}${r.name} vs ${label} ${fmt(r.ratio!)}x (${detail})`;
  }
  return `${LOSS_PREFIX}${r.name} vs ${label} not measured${r.status === 'too_few_pairs' ? `: ${r.reason}` : ` (${r.reason})`}`;
}

export interface BenchClassification { pairs: number; rust_no_worse: boolean; losses: string[]; rows: BenchRow[] }

export function classifyBench(summary: BenchSummary): BenchClassification {
  const rows: BenchRow[] = [];
  const unpaired: TsEngine[] = [];
  for (const e of TS_ENGINES) {
    const pair = summary.pairs.find((p) => p.against === e);
    if (!pair) unpaired.push(e);
    const extraOps = [...new Set([...Object.keys(pair?.latency ?? {}), ...Object.keys(pair?.missing ?? {})])].filter((o) => !EXPECTED_OPS.includes(o)).sort();
    for (const op of [...EXPECTED_OPS, ...extraOps]) for (const q of QUANTILES) rows.push(latencyRow(pair, e, op, q));
    for (const m of EXPECTED_METRICS) rows.push(metricRow(pair, e, m.name, m.direction));
    const extras = (pair?.metrics ?? []).filter((m: MetricEntry) => !EXPECTED_METRICS.some((x) => x.name === m.metric) && !/ (p50|p99)$/.test(m.metric)).map((m) => m.metric).sort();
    for (const name of extras) rows.push(metricRow(pair, e, name, pair!.metrics.find((m) => m.metric === name)!.direction));
  }
  const counted = rows.filter((r) => r.kind === 'latency' && r.n_pairs !== null && r.n_pairs > 0).map((r) => r.n_pairs as number);
  const noPair = (r: BenchRow): boolean => unpaired.includes(r.against);
  const losses = [
    ...rows.filter((r) => r.status === 'worse').map(lossText),
    ...rows.filter((r) => r.status !== 'worse' && !['better', 'not_shown'].includes(r.status) && !noPair(r)).map(lossText),
    ...unpaired.map((e) => `${LOSS_PREFIX}every operation class and metric vs ${ENGINE_LABEL[e]} not measured (the receipt has no Rust pair against ${ENGINE_LABEL[e]})`),
  ];
  return { pairs: counted.length ? counted.reduce((a, b) => Math.min(a, b)) : 0, rust_no_worse: rows.every((r) => r.status === 'better' || r.status === 'not_shown'), losses, rows };
}

// ─── status ─────────────────────────────────────────────────────────

export type StoredSummary = { state: 'absent' } | { state: 'unreadable'; reason: string } | { state: 'ok'; summary: BenchSummary };

const REIMPORT = 'Import the receipt again: gbrain engine shadow bench --import <receipt.json>.';

/** The stored summary, validated by the same schema the import used. A missing file is absence; anything else wrong is unreadable, never zeros. */
export function readBenchSummary(dir: string): StoredSummary {
  const read = readBoundedFile(benchSummaryPath(dir), MAX_SUMMARY_BYTES);
  if (!read.ok) return read.failure === 'not_found' ? { state: 'absent' } : { state: 'unreadable', reason: `the stored bench summary cannot be read (${read.failure}: ${read.detail}). ${REIMPORT}` };
  let json: unknown;
  try { json = JSON.parse(read.bytes.toString('utf8')); } catch { return { state: 'unreadable', reason: `the stored bench summary is not valid JSON. ${REIMPORT}` }; } // silent-read-ok: reported as unreadable with no readiness fields
  const bad = validateSummary(json);
  return bad ? { state: 'unreadable', reason: `the stored bench summary is not valid (${bad}). ${REIMPORT}` } : { state: 'ok', summary: json as BenchSummary };
}

const compare = (a: string | null | undefined, b: string | null | undefined): Match => (!a || !b ? 'unknown' : a.toLowerCase() === b.toLowerCase() ? 'same' : 'differs');

/** The `bench` block of the status document: the readiness fields when a receipt is stored, both sources always. Build identity is reported, never gating. */
export function buildBenchStatus(o: { dir: string; primaryEngine: string | null }): { bench: BenchStatus } {
  const owner = { state: 'not_measured' as const, reason: OWNER_BRAIN_NOT_BUILT };
  const sources = (bench_corpus: CorpusSource): { bench: BenchStatus } => ({ bench: { filtered_vector_margin: FILTERED_VECTOR_MARGIN, sources: { bench_corpus, owner_brain: owner } } });
  const stored = readBenchSummary(o.dir);
  if (stored.state === 'absent') return sources({ state: 'not_measured', reason: NO_RECEIPT });
  if (stored.state === 'unreadable') return sources({ state: 'unreadable', reason: stored.reason });
  const s = stored.summary;
  const c = classifyBench(s);
  const epoch = readEpoch(o.dir);
  const a = s.receipt.gbrain;
  const corpus: CorpusSource = {
    state: 'measured', primary_engine: o.primaryEngine, imported_at: s.imported_at, source_file: s.source_file, receipt_sha256: s.receipt_sha256, receipt: s.receipt,
    build_match: { commit: compare(a.commit, epoch?.build?.gbrain_commit), addon: compare(a.rust_addon?.sha256, epoch?.inputs.rust_addon_sha256), target: compare(a.rust_addon?.target, epoch?.build?.addon_target), epoch_id: epoch?.epoch_id ?? null },
    rows: c.rows,
  };
  const block = sources(corpus).bench;
  return { bench: { pairs: c.pairs, rust_no_worse: c.rust_no_worse, losses: c.losses, ...block } };
}

// ─── rendering ──────────────────────────────────────────────────────

const VERDICT_LABEL: Record<string, string> = { no_slower: 'no slower', no_slower_with_exceptions: 'no slower with named exceptions', not_shown: 'not shown', slower: 'slower' };

function rowText(r: BenchRow): string {
  const parts: string[] = [];
  if (r.n_pairs !== null) parts.push(`${r.n_pairs} pairs`);
  if (r.ratio !== null) parts.push(`ratio ${fmt(r.ratio)}`);
  if (r.kind === 'latency') { if (r.ratio !== null) parts.push(r.ci95 ? interval(r.ci95) : 'no interval'); }
  else if (r.ratio !== null) parts.push(r.ci95 ? `${interval(r.ci95)} ${sampleText(r.sample, ENGINE_LABEL[r.against])}` : 'point estimate no interval');
  const verdict: Record<RowStatus, string> = {
    better: 'better', worse: 'worse', not_shown: 'not shown (inconclusive, not faster)',
    too_few_pairs: `not measured: ${r.reason}`, missing: `not measured (${r.reason})`, not_measured: `not measured (${r.reason})`,
  };
  parts.push(verdict[r.status]);
  return `${r.name}: ${parts.join(', ')}`;
}

/** The status and report lines: every class row, every metric row, every loss, the build comparison and both sources. Two-space indented. */
export function renderBenchStatus(bench: BenchStatus): string[] {
  const lines = ['  speed (criterion 8, reported, not gating: D23)'];
  const src = bench.sources.bench_corpus;
  const head = 'bench corpus (engine-bench, not this brain)';
  if (src.state !== 'measured') lines.push(`  ${head}: ${src.state === 'unreadable' ? 'unreadable' : 'not measured'} (${src.reason})`);
  else {
    const r = src.receipt;
    lines.push(`  ${head}: ${r.scale ?? 'unknown'} pages, ${r.counted ? 'counted' : 'development run (uncounted)'}, gbrain ${r.gbrain.version ?? 'unknown'} ${r.gbrain.commit?.slice(0, 12) ?? 'unknown commit'}, imported ${src.imported_at.slice(0, 10)}`);
    if (r.gbrain.checkout_dirty) lines.push('  warning: ran from a gbrain checkout with uncommitted changes');
    const m = (v: Match): string => (v === 'differs' ? 'differs (reported, not gating)' : v);
    lines.push(`  build vs evidence epoch: commit ${m(src.build_match.commit)}, addon ${m(src.build_match.addon)}, target ${m(src.build_match.target)}`);
    lines.push('  ratios are Rust over the other engine: above 1 is slower for latency, cold start and RSS; below 1 is slower for throughput and import');
    for (const e of TS_ENGINES) {
      const rows = src.rows.filter((x) => x.against === e);
      lines.push(`  vs ${ENGINE_LABEL[e]}${src.primary_engine === e ? " (this brain's primary)" : ''}:`);
      for (const row of rows) lines.push(`    ${rowText(row)}`);
      const n = (s: RowStatus[]): number => rows.filter((x) => s.includes(x.status)).length;
      lines.push(`    summary vs ${ENGINE_LABEL[e]}: ${n(['better'])} better, ${n(['worse'])} worse, ${n(['not_shown'])} not shown, ${n(['too_few_pairs', 'missing', 'not_measured'])} not measured`);
    }
    lines.push(`  engine-bench's own verdict (preregistered margins, beside the stricter rule used here): ${VERDICT_LABEL[r.speed_verdict ?? ''] ?? 'not recorded'}`);
    lines.push(bench.rust_no_worse ? '  Rust no worse on every measured class and metric against both engines' : `  Rust not shown to be no worse: ${bench.losses?.length ?? 0} losses or unmeasured rows (named below)`);
    for (const l of bench.losses ?? []) lines.push(`    ${l}`);
  }
  lines.push('  this brain (gbrain engine shadow bench): not measured (not built)');
  lines.push(`  filtered vector margin: not evaluated (${FILTERED_VECTOR_MARGIN})`);
  return lines;
}
