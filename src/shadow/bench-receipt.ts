/**
 * The engine-bench speed receipt, read into the summary shadow status keeps (plan "Shadow status reports engine-bench
 * speed for swap readiness criterion 8"). `gbrain engine shadow bench --import <receipt>` calls `importBenchReceipt`;
 * `src/shadow/bench.ts` classifies the stored summary. The receipt is gbrain-evals' `eval/runner/engine-bench/perf.ts`
 * output (`benchmark: "engine-bench"`, `stage: "speed"`, `schema_version: 1`), a benchmark-corpus run and never this
 * brain's own samples.
 *
 * One rule runs through this file: a receipt is never trusted by which keys it happens to hold. The operation classes
 * and metrics a schema 1 receipt must cover are pinned here (`EXPECTED_OPS`, `EXPECTED_METRICS`), a value is checked
 * for meaning (finite, ordered, the right direction), and the same `validateSummary` runs on import and on every
 * read of the stored file, so a file that would not import is never read as evidence.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { OperationError } from '../core/ops/contract.ts';
import { readBoundedFile } from './bench-file.ts';

export type TsEngine = 'pglite' | 'postgres';
export const TS_ENGINES: readonly TsEngine[] = ['pglite', 'postgres'];
export const ENGINE_LABEL: Record<TsEngine, string> = { pglite: 'PGLite', postgres: 'Postgres' };

export const BENCH_RECEIPT_SCHEMA_VERSIONS: readonly number[] = [1];
/** The 13 operations `perf.ts` times per query on both engines of a pair (`PAIRED_OPS`), in its order. */
export const EXPECTED_OPS: readonly string[] = [
  'get_page', 'put_page', 'search_keyword', 'search_vector', 'search_hybrid', 'search_keyword_filtered', 'search_vector_filtered',
  'graph_walk_d1', 'graph_walk_d2', 'graph_walk_d3', 'get_backlinks', 'get_timeline', 'list_pages',
];
export const QUANTILES = ['p50', 'p99'] as const;
export type Quantile = (typeof QUANTILES)[number];
export type Direction = 'lower_is_better' | 'higher_is_better';
export interface ExpectedMetric { name: string; direction: Direction; kind: 'throughput' | 'cold_start' | 'point' }
/** The non-latency metrics `perf.ts` emits for each pair: read and write throughput at 1, 4 and 16 clients, cold start, import, peak RSS. */
export const EXPECTED_METRICS: readonly ExpectedMetric[] = [
  ...[1, 4, 16].flatMap((c): ExpectedMetric[] => (['read', 'write'] as const).map((k) => ({ name: `${k} throughput at ${c} client${c === 1 ? '' : 's'}`, direction: 'higher_is_better', kind: 'throughput' }))),
  { name: 'cold start', direction: 'lower_is_better', kind: 'cold_start' },
  { name: 'corpus import', direction: 'higher_is_better', kind: 'point' },
  { name: 'peak RSS', direction: 'lower_is_better', kind: 'point' },
];
/** The preregistration's `engine-bench-margins` block. A receipt with other values used other intervals, so it is refused. */
export const ENGINE_BENCH_MARGINS = { latency_ratio: 1.10, throughput_ratio: 0.90, point_ratio: 1.10, exception_ratio: 1.5, bootstrap_draws: 10000, quantile_draws: 2000 };
export const MAX_RECEIPT_BYTES = 256 * 1024 * 1024;
export const MAX_SUMMARY_BYTES = 8 * 1024 * 1024;
/** Most operation names (measured plus refused) and metric rows one Rust pair may carry. perf.ts writes 13 operations and 35 metrics; a wider receipt is not an engine-bench receipt, and every row becomes a line of status and report. */
export const MAX_OPERATIONS_PER_PAIR = 64;
export const MAX_METRICS_PER_PAIR = 256;
export const BENCH_DOCS = 'docs/guides/engine-shadow-bench.md';
export const BENCH_SUMMARY_VERSION = 1;
const SPEED_VERDICTS = ['no_slower', 'no_slower_with_exceptions', 'not_shown', 'slower'];

export interface Ratio { ratio: number | null; ci95: [number, number] | null }
export interface LatencyEntry { n: number; p50_ratio: Ratio; p99_ratio: Ratio }
export type MetricSample =
  | { kind: 'throughput_reps'; reps: number }
  | { kind: 'cold_starts'; rust: number | null; reference: number | null }
  | { kind: 'single_point' };
export interface MetricEntry { metric: string; direction: Direction; ratio: number | null; ci95: [number, number] | null; status: 'pass' | 'fail' | 'inconclusive' | 'missing'; core: boolean; sample: MetricSample | null }
export interface BenchPair { against: TsEngine; missing: Record<string, string>; latency: Record<string, LatencyEntry>; metrics: MetricEntry[] }
export interface BenchSummary {
  version: 1;
  imported_at: string;
  /** The file's base name only: no home path reaches status. */
  source_file: string;
  receipt_sha256: string;
  receipt: {
    schema_version: number; counted: boolean; generated_at: string | null; evals_commit: string | null; scale: number | null; attested: boolean; speed_verdict: string | null;
    gbrain: { commit: string | null; version: string | null; ref: string | null; checkout_dirty: boolean; rust_addon: { sha256: string | null; target: string | null; engine_build: string | null } | null };
  };
  pairs: BenchPair[];
}

export const benchSummaryPath = (dir: string): string => join(dir, 'evidence', 'bench', 'engine-bench-speed.json');

// ─── value checks ───────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
/** Text that reaches status and loss lines: short, one line, no comma or semicolon (readiness joins losses with both). */
const isSafeText = (v: unknown): v is string => typeof v === 'string' && v.length <= 200 && !/[\u0000-\u001f\u007f,;]/.test(v);
const OP_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const METRIC_NAME = /^[A-Za-z0-9_ ]{1,64}$/;

/** Receipt text, made safe: capped, one line, no comma or semicolon, no absolute path. */
export function sanitizeText(v: unknown, max = 200): string {
  return String(v ?? '').replace(/(?:\/[\w.@~+-]+){2,}/g, '<path>').replace(/[\u0000-\u001f\u007f,;]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
const safeOrNull = (v: unknown): string | null => (typeof v === 'string' && v ? sanitizeText(v) : null);
function show(v: unknown): string {
  if (typeof v === 'string') return JSON.stringify(v.slice(0, 40));
  if (typeof v === 'number' || typeof v === 'boolean' || v === null || v === undefined) return String(v);
  return Array.isArray(v) ? 'an array' : typeof v;
}

function checkCi(ci: unknown, where: string): string | null {
  if (ci === null) return null;
  if (!Array.isArray(ci) || ci.length !== 2 || !isNum(ci[0]) || !isNum(ci[1])) return `${where} must be null or two finite non-negative numbers (found ${show(ci)})`;
  return ci[0] > ci[1] ? `${where} is reversed (low ${ci[0]} is above high ${ci[1]})` : null;
}

function checkLatencyRatio(r: unknown, where: string): string | null {
  if (!isObj(r)) return `${where} is not an object`;
  const bad = checkCi(r.ci95, `${where}.ci95`);
  if (bad) return bad;
  if (r.ratio === null) return r.ci95 === null ? null : `${where}.ratio is null but an interval is given`;
  return isNum(r.ratio) ? null : `${where}.ratio must be a finite non-negative number (found ${show(r.ratio)})`;
}

const LATENCY_METRIC = /^([a-z][a-z0-9_]*) (p50|p99)$/;
const expectedMetric = (name: string): ExpectedMetric | undefined => EXPECTED_METRICS.find((m) => m.name === name);

function checkSample(s: unknown, where: string): string | null {
  if (s === null) return null;
  if (!isObj(s)) return `${where} must be null or an object`;
  if (s.kind === 'throughput_reps') return isCount(s.reps) ? null : `${where}.reps must be a non-negative integer`;
  if (s.kind === 'cold_starts') return (s.rust === null || isCount(s.rust)) && (s.reference === null || isCount(s.reference)) && (s.rust !== null || s.reference !== null) ? null : `${where} counts must be non-negative integers or null, and not both null`;
  return s.kind === 'single_point' ? null : `${where}.kind is ${show(s.kind)}`;
}

function checkMetric(m: unknown, where: string): string | null {
  if (!isObj(m)) return `${where} is not an object`;
  if (typeof m.metric !== 'string' || !METRIC_NAME.test(m.metric)) return `${where}.metric is not a metric name (found ${show(m.metric)})`;
  if (m.direction !== 'lower_is_better' && m.direction !== 'higher_is_better') return `${where}.direction must be lower_is_better or higher_is_better (found ${show(m.direction)})`;
  const known = expectedMetric(m.metric);
  const want: Direction | undefined = known?.direction ?? (LATENCY_METRIC.test(m.metric) ? 'lower_is_better' : undefined);
  if (want && m.direction !== want) return `${where} (${m.metric}) has direction ${m.direction}, expected ${want}`;
  if (!['pass', 'fail', 'inconclusive', 'missing'].includes(m.status as string)) return `${where}.status must be pass, fail, inconclusive or missing (found ${show(m.status)})`;
  if (typeof m.core !== 'boolean') return `${where}.core must be true or false`;
  const sample = checkSample(m.sample ?? null, `${where}.sample`);
  if (sample) return sample;
  if (m.status === 'missing') return m.ratio === null && m.ci95 === null ? null : `${where} (${m.metric}) is missing but carries a number (a missing metric has ratio null and ci95 null)`;
  if (!isNum(m.ratio)) return `${where}.ratio of a measured metric must be a finite non-negative number (found ${show(m.ratio)})`;
  const ci = checkCi(m.ci95, `${where}.ci95`);
  if (ci) return ci;
  if (m.ci95 === null && (known?.kind === 'throughput' || known?.kind === 'cold_start')) return `${where} (${m.metric}) is measured but has no interval`;
  return null;
}

/** The reason `s` is not a bench summary, or null. Runs on the summary an import is about to write and on every read of the stored file. */
export function validateSummary(s: unknown): string | null {
  if (!isObj(s)) return 'the summary is not an object';
  if (s.version !== BENCH_SUMMARY_VERSION) return `the summary version is ${show(s.version)} (expected ${BENCH_SUMMARY_VERSION})`;
  if (typeof s.imported_at !== 'string' || !Number.isFinite(Date.parse(s.imported_at))) return 'imported_at is not a date';
  if (!isSafeText(s.source_file) || /[\\/]/.test(s.source_file)) return 'source_file must be a base name';
  if (typeof s.receipt_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(s.receipt_sha256)) return 'receipt_sha256 is not a SHA-256';
  const r = s.receipt;
  if (!isObj(r)) return 'receipt is missing';
  if (!BENCH_RECEIPT_SCHEMA_VERSIONS.includes(r.schema_version as number)) return `receipt.schema_version is ${show(r.schema_version)}`;
  if (typeof r.counted !== 'boolean' || typeof r.attested !== 'boolean') return 'receipt.counted and receipt.attested must be true or false';
  for (const k of ['generated_at', 'evals_commit'] as const) if (r[k] !== null && !isSafeText(r[k])) return `receipt.${k} is not safe text`;
  if (r.scale !== null && !isNum(r.scale)) return 'receipt.scale must be null or a number';
  if (r.speed_verdict !== null && !SPEED_VERDICTS.includes(r.speed_verdict as string)) return `receipt.speed_verdict is ${show(r.speed_verdict)}`;
  const g = r.gbrain;
  if (!isObj(g) || typeof g.checkout_dirty !== 'boolean') return 'receipt.gbrain is missing or has no checkout_dirty';
  for (const k of ['commit', 'version', 'ref'] as const) if (g[k] !== null && !isSafeText(g[k])) return `receipt.gbrain.${k} is not safe text`;
  if (g.rust_addon !== null) {
    const a = g.rust_addon;
    if (!isObj(a) || (a.sha256 !== null && !(typeof a.sha256 === 'string' && /^[0-9a-f]{64}$/.test(a.sha256)))) return 'receipt.gbrain.rust_addon.sha256 is not a SHA-256';
    for (const k of ['target', 'engine_build'] as const) if (a[k] !== null && !isSafeText(a[k])) return `receipt.gbrain.rust_addon.${k} is not safe text`;
  }
  if (!Array.isArray(s.pairs) || s.pairs.length === 0) return 'the summary has no Rust pair';
  const seen = new Set<unknown>();
  for (const [i, p] of s.pairs.entries()) {
    const where = `pairs[${i}]`;
    if (!isObj(p) || !TS_ENGINES.includes(p.against as TsEngine)) return `${where}.against must be pglite or postgres`;
    if (seen.has(p.against)) return `${where}: two Rust pairs against ${p.against}`;
    seen.add(p.against);
    if (!isObj(p.missing) || !isObj(p.latency) || !Array.isArray(p.metrics)) return `${where} needs missing, latency and metrics`;
    const operations = Object.keys(p.missing).length + Object.keys(p.latency).length;
    if (operations > MAX_OPERATIONS_PER_PAIR) return `${where} is larger than an engine-bench pair: it names more than ${MAX_OPERATIONS_PER_PAIR} operations (${operations}; perf.ts writes ${EXPECTED_OPS.length}), and every one becomes a line of status and report`;
    if (p.metrics.length > MAX_METRICS_PER_PAIR) return `${where} is larger than an engine-bench pair: it has more than ${MAX_METRICS_PER_PAIR} metrics (${p.metrics.length}; perf.ts writes ${EXPECTED_OPS.length * QUANTILES.length + EXPECTED_METRICS.length}), and every one becomes a line of status and report`;
    for (const [op, why] of Object.entries(p.missing)) {
      if (!OP_NAME.test(op) || !isSafeText(why)) return `${where}.missing.${sanitizeText(op, 40)} is not an operation with a text reason`;
      if (op in p.latency) return `${where}: ${op} is both measured and missing`;
    }
    for (const [op, e] of Object.entries(p.latency)) {
      if (!OP_NAME.test(op) || !isObj(e)) return `${where}.latency has a bad operation entry ${sanitizeText(op, 40)}`;
      if (!isCount(e.n)) return `${where}.latency.${op}.n must be a non-negative integer (found ${show(e.n)})`;
      const bad = checkLatencyRatio(e.p50_ratio, `${where}.latency.${op}.p50_ratio`) ?? checkLatencyRatio(e.p99_ratio, `${where}.latency.${op}.p99_ratio`);
      if (bad) return bad;
    }
    const names = new Set<string>();
    for (const [j, m] of p.metrics.entries()) {
      const bad = checkMetric(m, `${where}.metrics[${j}]`);
      if (bad) return bad;
      const name = (m as MetricEntry).metric;
      if (names.has(name)) return `${where}: the metric ${name} appears twice`;
      names.add(name);
    }
  }
  return null;
}

// ─── receipt → summary ──────────────────────────────────────────────

const refuse = (message: string, fix?: string): OperationError => new OperationError('invalid_params', `${message}; previous bench evidence unchanged`, fix ?? FIX_RECEIPT, BENCH_DOCS);
const FIX_RECEIPT = 'Provide an engine-bench stage=speed schema_version=1 receipt with a Rust arm (the file eval/runner/engine-bench/perf.ts writes) and rerun gbrain engine shadow bench --import <receipt.json> --json. Do not edit the receipt to make it pass.';

type Raw = Record<string, any>;
const pickRatio = (r: Raw | undefined): Ratio => ({ ratio: r?.ratio ?? null, ci95: r?.ci95 ?? null }) as Ratio;

function sampleFor(name: string, pair: Raw, arms: Raw, ref: string): MetricSample | null {
  const known = expectedMetric(name);
  if (known?.kind === 'point') return { kind: 'single_point' };
  if (known?.kind === 'throughput') {
    const t = Array.isArray(pair.throughput) ? pair.throughput.find((x: Raw) => isObj(x) && `${x.kind} throughput at ${x.clients} client${x.clients === 1 ? '' : 's'}` === name) : undefined;
    return t && isCount(t.reps) ? { kind: 'throughput_reps', reps: t.reps } : null;
  }
  if (known?.kind === 'cold_start') {
    // Each arm's count is kept on its own: a recorded zero stays known when the other arm's count is absent.
    const a = arms.rust?.cold_start?.reps;
    const b = arms[ref]?.cold_start?.reps;
    const rust = Array.isArray(a) ? a.length : null;
    const reference = Array.isArray(b) ? b.length : null;
    return rust === null && reference === null ? null : { kind: 'cold_starts', rust, reference };
  }
  return null;
}

export type ReceiptResult = { ok: true; summary: BenchSummary } | { ok: false; error: OperationError };

/** Reduces a parsed speed receipt to the summary (the raw `rows` are dropped), or says why it is refused. Coverage gaps are not refusals: they are kept and reported as not measured. */
export function summarizeReceipt(json: unknown, source: { file: string; sha256: string }, now: Date): ReceiptResult {
  const no = (message: string, fix?: string): ReceiptResult => ({ ok: false, error: refuse(message, fix) });
  if (!isObj(json)) return no('the file is JSON but not an engine-bench receipt (expected an object)');
  const r = json as Raw;
  if (r.benchmark !== 'engine-bench') return no(`benchmark is ${show(r.benchmark)} (expected "engine-bench")`);
  if (r.stage !== 'speed') return no(`stage is ${show(r.stage)} (expected "speed")`);
  if (!BENCH_RECEIPT_SCHEMA_VERSIONS.includes(r.schema_version)) return no(`schema_version ${show(r.schema_version)} is unsupported (expected ${BENCH_RECEIPT_SCHEMA_VERSIONS.join(' or ')})`);
  if (typeof r.counted !== 'boolean') return no(`counted is ${show(r.counted)} (expected true or false)`);
  const m = r.margins;
  if (!isObj(m) || Object.entries(ENGINE_BENCH_MARGINS).some(([k, v]) => m[k] !== v) || Object.keys(m).length !== Object.keys(ENGINE_BENCH_MARGINS).length) {
    return no(`margins differ from the preregistration's block (expected ${JSON.stringify(ENGINE_BENCH_MARGINS)})`, 'The receipt was made with other margins or interval draws, so its intervals are not comparable. Provide a receipt produced with the preregistered margins, and do not edit the margins in the file.');
  }
  const arms: Raw = isObj(r.arms) ? r.arms : {};
  const unavailable = arms.rust?.unavailable;
  if (unavailable) return no(`the Rust arm refused at stage ${sanitizeText(unavailable.stage, 40) || 'unknown'}: ${sanitizeText(unavailable.reason) || 'no reason given'}, so the receipt has no Rust measurements`, 'The receipt records that the Rust engine could not be measured at that build. Rerun perf.ts at a build where the Rust arm opens, then import the new receipt.');
  const pairs: BenchPair[] = [];
  for (const p of Object.values(isObj(r.pairs) ? r.pairs : {}) as Raw[]) {
    if (!isObj(p) || p.other !== 'rust' || !TS_ENGINES.includes(p.reference as TsEngine)) continue;
    const ref = p.reference as TsEngine;
    if (pairs.some((x) => x.against === ref)) return no(`two Rust pairs against ${ref}`);
    const latency: Record<string, LatencyEntry> = {};
    for (const [op, e] of Object.entries(isObj(p.latency) ? p.latency : {}) as Array<[string, Raw]>) {
      latency[op] = { n: e?.n, p50_ratio: pickRatio(e?.p50_ratio), p99_ratio: pickRatio(e?.p99_ratio) };
    }
    const missing: Record<string, string> = {};
    for (const [op, why] of Object.entries(isObj(p.missing) ? p.missing : {})) missing[op] = typeof why === 'string' ? sanitizeText(why) : (why as string);
    const badReps = (Array.isArray(p.throughput) ? p.throughput : []).find((x: Raw) => isObj(x) && x.reps !== undefined && !isCount(x.reps));
    if (badReps) return no(`the ${sanitizeText(badReps.kind, 12)} throughput at ${sanitizeText(badReps.clients, 8)} clients in the pair against ${ref} records reps ${show(badReps.reps)} (expected a non-negative integer)`);
    const badCold = [['rust', arms.rust], [ref, arms[ref]]].find(([, a]) => isObj(a) && isObj((a as Raw).cold_start) && (a as Raw).cold_start.reps !== undefined && !Array.isArray((a as Raw).cold_start.reps));
    if (badCold) return no(`the cold-start repetitions of the ${badCold[0]} arm are ${show((badCold[1] as Raw).cold_start.reps)} (expected a list of runs)`);
    const stray = (Array.isArray(p.metrics) ? p.metrics : []).find((x: Raw) => isObj(x) && x.against !== ref);
    if (stray) return no(`the metric ${sanitizeText(stray.metric, 64)} in the pair against ${ref} says it is against ${show(stray.against)} (a metric must name its own pair's engine)`);
    const metrics: MetricEntry[] = (Array.isArray(p.metrics) ? p.metrics : []).map((x: Raw) => ({
      metric: x?.metric, direction: x?.direction, ratio: x?.ratio ?? null, ci95: x?.ci95 ?? null, status: x?.status, core: x?.core,
      sample: typeof x?.metric === 'string' ? sampleFor(x.metric, p, arms, ref) : null,
    }));
    pairs.push({ against: ref, missing, latency, metrics });
  }
  if (pairs.length === 0) return no('the receipt has no Rust pair against PGLite or Postgres (it is a TypeScript-engines-only run)', 'This receipt has no Rust measurements. Run perf.ts with the pglite, postgres and rust engines at a build whose Rust arm opens, then import that receipt.');
  const overlay: Raw = isObj(r.gbrain?.overlay) ? r.gbrain.overlay : {};
  const addon: Raw | null = isObj(r.gbrain?.rust_addon) ? r.gbrain.rust_addon : null;
  const summary: BenchSummary = {
    version: BENCH_SUMMARY_VERSION, imported_at: now.toISOString(), source_file: sanitizeText(basename(source.file), 120) || 'receipt.json', receipt_sha256: source.sha256,
    receipt: {
      schema_version: r.schema_version, counted: r.counted, generated_at: safeOrNull(r.generated_at), evals_commit: safeOrNull(r.evals_commit),
      scale: isNum(r.options?.scale) ? r.options.scale : null, attested: isObj(r.preregistration_attestation), speed_verdict: typeof r.speed?.verdict === 'string' ? r.speed.verdict : null,
      gbrain: {
        commit: safeOrNull(overlay.commit ?? r.gbrain?.product?.loaded_git_head), version: safeOrNull(r.gbrain?.version), ref: safeOrNull(overlay.ref),
        checkout_dirty: overlay.checkout_dirty === true,
        rust_addon: addon ? { sha256: typeof addon.sha256 === 'string' ? addon.sha256 : null, target: safeOrNull(addon.target), engine_build: safeOrNull(addon.engine_build) } : null,
      },
    },
    pairs: pairs.sort((a, b) => TS_ENGINES.indexOf(a.against) - TS_ENGINES.indexOf(b.against)),
  };
  const bad = validateSummary(summary);
  return bad ? no(bad) : { ok: true, summary };
}

// ─── the file and the store ─────────────────────────────────────────

const storage = (message: string, fix: string): OperationError => new OperationError('storage_error', message, fix, BENCH_DOCS);

/** Reads, validates and stores the receipt. Nothing is written until every check has passed; a failure leaves the previous summary active. */
export function importBenchReceipt(dir: string, path: string, opts: { maxBytes?: number; now?: Date } = {}): ReceiptResult {
  const read = readBoundedFile(path, opts.maxBytes ?? MAX_RECEIPT_BYTES);
  if (!read.ok) {
    const fixes = {
      symlink: 'Pass the real file path, not a symbolic link, then rerun gbrain engine shadow bench --import <receipt.json> --json.',
      not_regular: 'Pass the path of a regular receipt file (a file perf.ts wrote), not a directory, pipe or device, then rerun gbrain engine shadow bench --import <receipt.json> --json.',
      permission: 'Make the receipt readable to the account that runs gbrain, then rerun gbrain engine shadow bench --import <receipt.json> --json.',
      too_large: 'Pass the receipt perf.ts wrote (the published 10000-page receipt is about 5 MB), not a larger or growing file.',
      io: 'Check that the path is readable, then rerun gbrain engine shadow bench --import <receipt.json> --json.',
    } as const;
    if (read.failure === 'not_found') return { ok: false, error: new OperationError('not_found', `no receipt file at the path given (${sanitizeText(path, 120)}); previous bench evidence unchanged`, 'Give the path of an existing engine-bench speed receipt: gbrain engine shadow bench --import <receipt.json> --json.', BENCH_DOCS) };
    const what = read.failure === 'too_large' ? `the receipt is larger than ${opts.maxBytes ?? MAX_RECEIPT_BYTES} bytes` : read.failure === 'io' ? `the receipt could not be read (${read.detail})` : `the receipt path is ${read.detail}`;
    return { ok: false, error: refuse(what, fixes[read.failure]) };
  }
  const sha256 = createHash('sha256').update(read.bytes).digest('hex');
  let json: unknown;
  try { json = JSON.parse(read.bytes.toString('utf8')); } catch { return { ok: false, error: refuse('the receipt is not valid JSON') }; } // silent-read-ok: refused with a reason, nothing stored
  const result = summarizeReceipt(json, { file: path, sha256 }, opts.now ?? new Date());
  if (!result.ok) return result;
  const final = benchSummaryPath(dir);
  const tmp = `${final}.${process.pid}.tmp`;
  const text = JSON.stringify(result.summary, null, 2) + '\n';
  if (Buffer.byteLength(text) > MAX_SUMMARY_BYTES) return { ok: false, error: refuse(`the reduced bench summary would be larger than ${MAX_SUMMARY_BYTES} bytes, the most a status read accepts`, 'Pass the receipt perf.ts wrote: a receipt with this many extra operation entries is not an engine-bench receipt. Do not edit it.') };
  try {
    mkdirSync(join(dir, 'evidence', 'bench'), { recursive: true, mode: 0o700 });
    writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' });
    renameSync(tmp, final);
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* the temp file is never read as evidence either way */ }
    const code = (e as NodeJS.ErrnoException).code ?? 'error';
    return { ok: false, error: storage(`could not store the bench summary (${code}); the previous bench evidence is still active and no partial file was left`, 'Run gbrain engine shadow status --json to confirm the earlier bench evidence, fix the cause (permission, free space or a read-only disk), then rerun the same import once.') };
  }
  return result;
}
