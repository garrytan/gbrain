/**
 * Gate policy for the scale tier (spec F4c; O-CEO-16 / O-ENG-16 / O-CEO-9).
 * Pure: `evaluateScaleGates` reads a finished report and decides which gates
 * pass, which fail, and the exit code. scripts/scale/run.ts calls it, the
 * scale-tier workflow enforces it with `--enforce`, and
 * test/scripts/scale-gates.test.ts plants slow ops and wrong answers in it.
 *
 * Enforced from day one (under --enforce): import rate, known answers for
 * every timed op and data check, no-op re-import, no duplicate documents
 * across sources, the import phase timer.
 * The stats-dependent gates (planner health and the budgets phase timer) are
 * enforced only when PLANNER_HEALTH_ENFORCED is true.
 * Interactive ceilings and calibrated budgets stay report-only until
 * scripts/scale/trend.ts says "ceilings stable" and a reviewer sets the repo
 * variable GBRAIN_SCALE_ENFORCE_CEILINGS=1.
 */

import { ORPHANS_MAX_LIMIT } from '../../src/core/ops/orphans.ts';
import { PLANNER_STATS_MIN_PENDING } from '../../src/core/planner-stats.ts';

/**
 * The one switch for the stats-dependent gates: planner health (hot-table
 * statistics after the first read, Nested Loop inner loops in the key plans)
 * and the budgets phase timer, whose time un-analyzed plans dominate. On since
 * F4b (row-delta ANALYZE during import and on the first planner-sensitive
 * read): at 10k PGLite pages its key plans run 42-52 inner loops against a
 * 100k gate and the budgets phase 25 s against 300 s. Set false to make them
 * report-only again.
 */
export const PLANNER_HEALTH_ENFORCED = true;

export const RATE_RATIO_MAX = 1.5;
/** Below this size per-process warmup dominates the per-page cost, so the rate gate is reported but not enforced. */
export const RATE_MIN_PAGES = 1000;
export const TOTAL_VS_HALF_MAX = 2.5;

/** One timing basis of the import: per-page cost of the first and last 10%, and total vs the halfway mark. */
export interface RateMeasure {
  per_page_ms_first10: number;
  per_page_ms_last10: number;
  rate_ratio: number;
  total_ms: number;
  ms_at_half: number;
  total_vs_half: number;
}

/**
 * Per-file wall and CPU milliseconds from `gbrain import --progress-json --progress-interval 0`
 * stderr: one `import.files` tick per file, each with cumulative `elapsed_ms` and `cpu_ms`.
 * A file without a tick, or a tick without a field, yields NaN for the caller to reject.
 */
export function importProgressPerFile(stderr: string): { wallMs: number[]; cpuMs: number[] } {
  const wall: number[] = [];
  const cpu: number[] = [];
  for (const line of stderr.split('\n')) {
    if (!line.startsWith('{')) continue;
    const event = JSON.parse(line) as { event?: string; phase?: string; done?: number; elapsed_ms?: number; cpu_ms?: number };
    if (event.event !== 'tick' || event.phase !== 'import.files' || typeof event.done !== 'number') continue;
    wall[event.done - 1] = event.elapsed_ms ?? Number.NaN;
    cpu[event.done - 1] = event.cpu_ms ?? Number.NaN;
  }
  const perFile = (cumulative: number[]) => Array.from(cumulative, (ms, i) => (ms ?? Number.NaN) - (i > 0 ? cumulative[i - 1] ?? Number.NaN : 0));
  return { wallMs: perFile(wall), cpuMs: perFile(cpu) };
}

export function rateMeasure(perPageMs: number[]): RateMeasure {
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const tenth = Math.max(1, Math.floor(perPageMs.length / 10));
  const first = sum(perPageMs.slice(0, tenth)) / tenth;
  const last = sum(perPageMs.slice(-tenth)) / tenth;
  const half = sum(perPageMs.slice(0, Math.floor(perPageMs.length / 2)));
  const total = sum(perPageMs);
  const round = (n: number, places: number) => Math.round(n * 10 ** places) / 10 ** places;
  return { per_page_ms_first10: round(first, 1), per_page_ms_last10: round(last, 1), rate_ratio: round(last / first, 2),
    total_ms: Math.round(total), ms_at_half: Math.round(half), total_vs_half: round(total / half, 2) };
}

/**
 * The timing basis the import-rate gate judges. PGLite runs on the import process's main thread, so
 * that thread's CPU time holds all the import's work and none of the time a shared host takes the CPU away, which
 * inflates wall time on CI runners. Postgres does its work in the server, outside that process's
 * CPU time, so it keeps wall time.
 */
export function importRateBasis(engine: ScaleReport['engine']): 'cpu' | 'wall' {
  return engine === 'pglite' ? 'cpu' : 'wall';
}
export const LOOPS_PER_PAGE_MAX = 10;
export const HOT_TABLES = ['pages', 'links', 'content_chunks', 'timeline_entries', 'facts', 'takes'] as const;
/**
 * The planner-stats gate checks only hot tables holding more than this many rows: F4b analyzes a
 * table once its pending row count passes max(500, 10% of its rows), so a smaller table may
 * correctly have no statistics yet.
 */
export const PLANNER_STATS_MIN_ROWS = PLANNER_STATS_MIN_PENDING;
/** The plans the planner-health gate inspects (every captured read statement of these ops). */
export const KEY_PLAN_OPS = ['get_backlinks', 'search (MCP path, remote)', 'get_health', 'find_orphans'] as const;
export const HEADLINE_OP = 'search (MCP path, remote)';
/** Interactive ceilings (p50 ms), defined at 10k pages; report-only until trend.ts says stable. */
export const CEILINGS_MS: Record<string, number> = { 'search (MCP path, remote)': 500, get_health: 1000 };
export const CEILING_PAGES = 10_000;
/** The interactive ceilings that apply at a brain size: defined at 10k, so they bind brains up to 10k pages. */
export function ceilingsFor(pages: number): Record<string, number> {
  return pages <= CEILING_PAGES ? CEILINGS_MS : {};
}
/** Calibrated budgets are this multiple of the first calibration run's p50 (O-CEO-9). */
export const BUDGET_MULTIPLIER = 3;

/** Phase ceilings: 10k pages <= 20 min per engine, 50k <= 100 min (import 75, budgets 25); linear in pages, floor 2 min. */
export function phaseLimitsMs(pages: number): Record<'import' | 'budgets', number> {
  const minutes = (perThousand: number) => Math.max(2, (pages / 1000) * perThousand) * 60_000;
  return { import: minutes(1.5), budgets: minutes(0.5) };
}

export interface PlanStatement { sql: string; execution_ms: number; inner_loops: number; text?: string }
export interface OpPlan { statements: number; slowest?: PlanStatement; worst_loops?: PlanStatement }
export interface OpResult {
  op: string;
  p50_ms: number;
  runs_ms: number[];
  known_answer: 'pass' | 'fail';
  detail?: string;
  plan?: OpPlan;
}
export interface DataCheck { check: string; status: 'pass' | 'fail'; detail?: string }
export interface ScaleReport {
  engine: 'pglite' | 'postgres';
  pages: number;
  seed: number;
  import_mode: 'cli' | 'content';
  /** Both timing bases, reported for every engine; `importRateBasis` picks the one the gate judges. */
  import: { wall: RateMeasure; cpu: RateMeasure };
  /**
   * Read after the first timed op (`probed_after`), not right after import: F4b analyzes on the
   * first planner-sensitive read by design. `hot_table_rows` is each table's row count.
   */
  planner: { hot_table_stat_rows: Record<string, number>; hot_table_rows: Record<string, number>; probed_after: string };
  ops: OpResult[];
  data: DataCheck[];
  /** F4d operational-ceiling measurements by check (scripts/scale/f4d.ts). */
  f4d?: Record<string, Record<string, unknown>>;
  phases_ms: Record<string, number>;
  budgets_ms?: Record<string, number>;
}
export interface GatePolicy { enforce: boolean; enforcePlanner: boolean; enforceCeilings: boolean }
export interface GateResult {
  gate: string;
  status: 'pass' | 'fail';
  /** Whether a failure of this gate fails the run (only meaningful under --enforce). */
  enforced: boolean;
  message: string;
  explain?: string;
}
export interface GateVerdict { results: GateResult[]; failures: GateResult[]; reportOnlyBreaches: GateResult[]; exitCode: 0 | 1 }

export function reproduceCommand(report: Pick<ScaleReport, 'engine' | 'pages' | 'seed' | 'import_mode'>): string {
  return `bun run test:scale -- --engine ${report.engine} --pages ${report.pages} --seed ${report.seed}`
    + `${report.import_mode === 'content' ? ' --import-mode content' : ''} --enforce`;
}

function planText(plan: PlanStatement | undefined): string | undefined {
  if (!plan) return undefined;
  return `-- ${plan.sql.replace(/\s+/g, ' ').trim()}\n${plan.text ?? '(no EXPLAIN text captured)'}`;
}

export function evaluateScaleGates(report: ScaleReport, policy: GatePolicy): GateVerdict {
  const repro = reproduceCommand(report);
  const results: GateResult[] = [];
  const add = (gate: string, ok: boolean, enforced: boolean, message: string, explain?: string) =>
    results.push({ gate, status: ok ? 'pass' : 'fail', enforced, message, ...(explain && !ok ? { explain } : {}) });

  const basis = importRateBasis(report.engine);
  const other = basis === 'cpu' ? 'wall' : 'cpu';
  const { rate_ratio, total_vs_half, per_page_ms_first10, per_page_ms_last10 } = report.import[basis];
  add('import_rate', rate_ratio <= RATE_RATIO_MAX && total_vs_half <= TOTAL_VS_HALF_MAX, report.pages >= RATE_MIN_PAGES,
    `import rate (${basis} time): last 10% per-page cost ${per_page_ms_last10} ms is ${rate_ratio}x the first 10% (${per_page_ms_first10} ms; gate <= ${RATE_RATIO_MAX}); `
    + `total import time is ${total_vs_half}x the time at the halfway mark (gate <= ${TOTAL_VS_HALF_MAX}). `
    + `Not judged on ${report.engine}: ${other} time ratio ${report.import[other].rate_ratio}, total/half ${report.import[other].total_vs_half}. `
    + `A rising per-page cost means import slows as the brain grows, usually stale planner statistics during import. Reproduce: ${repro}`);

  const { hot_table_stat_rows: statRows, hot_table_rows: tableRows, probed_after: probedAfter } = report.planner;
  const missing = HOT_TABLES.filter(t => tableRows[t]! > PLANNER_STATS_MIN_ROWS && !(statRows[t]! > 0));
  // Postgres statistics belong to autovacuum, whose timing gbrain does not control (F4b is PGLite-only):
  // missing pg_stats rows there are reported, never a failure.
  add('planner_stats', missing.length === 0, policy.enforcePlanner && report.engine === 'pglite',
    missing.length === 0 ? `planner stats: every hot table above ${PLANNER_STATS_MIN_ROWS} rows has pg_stats rows after ${probedAfter}`
      : `planner stats: no pg_stats rows after ${probedAfter} for ${missing.map(t => `${t} (${tableRows[t]} rows)`).join(', ')}; `
        + 'the planner is guessing row counts on these tables. '
        + (report.engine === 'pglite'
          ? 'Import and the first planner-sensitive read must leave statistics behind (F4b); '
            + `check \`gbrain doctor\` planner_stats_stale and run \`gbrain repair planner-stats --apply\` to confirm. Reproduce: ${repro}`
          : `Postgres autovacuum collects them on its own schedule, so this is report-only there. Reproduce: ${repro}`));

  const loopsLimit = LOOPS_PER_PAGE_MAX * report.pages;
  for (const name of KEY_PLAN_OPS) {
    const op = report.ops.find(o => o.op === name);
    const worst = op?.plan?.worst_loops;
    const loops = worst?.inner_loops ?? 0;
    add(`planner_loops:${name}`, loops <= loopsLimit, policy.enforcePlanner,
      `planner loops: ${name} key plan worst Nested Loop inner loops ${loops} (gate <= ${loopsLimit}, ${LOOPS_PER_PAGE_MAX}x pages). `
      + `A Nested Loop rescanning its inner side per row scales quadratically. Reproduce: ${repro}`, planText(worst));
  }

  for (const op of report.ops) {
    add(`known_answer:${op.op}`, op.known_answer === 'pass', true,
      op.known_answer === 'pass' ? `known answer: ${op.op} returned the expected result`
        : `known answer: ${op.op} returned a wrong answer: ${op.detail ?? 'no detail'}. Reproduce: ${repro}`,
      planText(op.plan?.slowest));
  }
  for (const check of report.data) {
    add(`data:${check.check}`, check.status === 'pass', true,
      check.status === 'pass' ? `data check: ${check.check} holds` : `data check: ${check.check} failed: ${check.detail ?? 'no detail'}. Reproduce: ${repro}`);
  }

  const limits = phaseLimitsMs(report.pages);
  for (const phase of ['import', 'budgets'] as const) {
    const ms = report.phases_ms[phase] ?? 0;
    // The budgets phase times the ops, so un-analyzed plans dominate it: it is stats-dependent and flips with planner health.
    add(`phase:${phase}`, ms <= limits[phase], phase === 'import' || policy.enforcePlanner,
      `phase timer: ${phase} took ${Math.round(ms / 1000)} s (ceiling ${Math.round(limits[phase] / 1000)} s at ${report.pages} pages). Reproduce: ${repro}`);
  }

  for (const [name, ceiling] of Object.entries(ceilingsFor(report.pages))) {
    const op = report.ops.find(o => o.op === name);
    if (!op) continue;
    add(`ceiling:${name}`, op.p50_ms < ceiling, policy.enforceCeilings,
      `interactive ceiling: ${name} p50 ${op.p50_ms} ms (ceiling < ${ceiling} ms). Reproduce: ${repro}`, planText(op.plan?.slowest));
  }
  for (const [name, budget] of Object.entries(report.budgets_ms ?? {})) {
    const op = report.ops.find(o => o.op === name);
    if (!op) continue;
    add(`budget:${name}`, op.p50_ms <= budget, policy.enforceCeilings,
      `calibrated budget: ${name} p50 ${op.p50_ms} ms (budget ${budget} ms, ${BUDGET_MULTIPLIER}x the calibration run). Reproduce: ${repro}`,
      planText(op.plan?.slowest));
  }

  const failures = results.filter(r => r.status === 'fail' && r.enforced);
  const reportOnlyBreaches = results.filter(r => r.status === 'fail' && !r.enforced);
  return { results, failures, reportOnlyBreaches, exitCode: policy.enforce && failures.length > 0 ? 1 : 0 };
}

/** The lines a run prints for its verdict: every failure with its EXPLAIN, then report-only breaches, then the outcome. */
export function verdictLines(report: ScaleReport, verdict: GateVerdict, policy: GatePolicy): string[] {
  const lines: string[] = [];
  for (const f of verdict.failures) {
    lines.push(`[scale] GATE FAIL ${f.gate}: ${f.message}`);
    if (f.explain) lines.push(...f.explain.split('\n').map(l => `[scale]   ${l}`));
  }
  for (const b of verdict.reportOnlyBreaches) lines.push(`[scale] REPORT-ONLY ${b.gate}: ${b.message}`);
  if (!policy.enforce) {
    lines.push(`[scale] report-only run: exit 0 regardless of gates (${verdict.failures.length} gate(s) would fail under --enforce).`);
  } else if (verdict.failures.length > 0) {
    lines.push(`[scale] ${verdict.failures.length} enforced gate(s) failed; exit 1. Fix the named op or phase, then rerun: ${reproduceCommand(report)}`);
  } else {
    lines.push(`[scale] all enforced gates passed (planner health and the budgets phase timer ${policy.enforcePlanner ? 'enforced' : 'report-only (PLANNER_HEALTH_ENFORCED=false)'}, `
      + `ceilings ${policy.enforceCeilings ? 'enforced' : 'report-only until GBRAIN_SCALE_ENFORCE_CEILINGS=1'}).`);
  }
  return lines;
}

/** Every `{slug, source_id?}` an op result carries, in order (op results nest hits in arrays or evidence objects). */
export function resultHits(value: unknown): Array<{ slug: string; source_id?: string }> {
  const hits: Array<{ slug: string; source_id?: string }> = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) { for (const item of v) walk(item); return; }
    if (!v || typeof v !== 'object') return;
    const o = v as Record<string, unknown>;
    if (typeof o.slug === 'string') hits.push({ slug: o.slug, ...(typeof o.source_id === 'string' ? { source_id: o.source_id } : {}) });
    for (const child of Object.values(o)) if (child && typeof child === 'object') walk(child);
  };
  walk(value);
  return hits;
}

/**
 * The find_orphans known-answer call: one page at the op's maximum size. The
 * op returns a page of rows (default 100) plus `total_orphans`, and recomputes
 * the whole orphan set per call, so the check reads totals and one maximal page
 * instead of paging (a 20k brain holds more orphans than one default page).
 */
export const FIND_ORPHANS_PARAMS = { limit: ORPHANS_MAX_LIMIT } as const;

/** Null when every fixture island is among the orphans, else what is wrong. */
export function orphansProblem(result: unknown, islands: readonly string[]): string | null {
  const r = (result ?? {}) as { orphans?: Array<{ slug?: string }>; total_orphans?: unknown };
  const rows = Array.isArray(r.orphans) ? r.orphans : [];
  const total = Number(r.total_orphans);
  if (!Number.isInteger(total)) return 'find_orphans returned no total_orphans';
  if (total < islands.length) return `find_orphans counts ${total} orphans, fewer than the fixture's ${islands.length} island pages`;
  if (rows.length < total) {
    return `find_orphans returned ${rows.length} of ${total} orphans in one call; the known-answer check reads every orphan in one page `
      + `of at most ${ORPHANS_MAX_LIMIT}, so this fixture size needs a paged check`;
  }
  const found = new Set(rows.map(h => h.slug));
  const missing = islands.filter(slug => !found.has(slug));
  return missing.length ? `${missing.length} of ${islands.length} island pages missing from find_orphans (first: ${missing[0]})` : null;
}
