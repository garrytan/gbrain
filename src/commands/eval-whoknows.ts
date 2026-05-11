/**
 * gbrain eval whoknows — v0.33 two-layer eval gate (ENG-D2).
 *
 * Layer 1 (PRIMARY, ship-blocking): hand-labeled fixture.
 *   For each {query, expected_top_3_slugs}, run `findExperts` and check
 *   whether top-3 result slugs intersect with expected_top_3_slugs.
 *   Pass = HIT_RATE_THRESHOLD (0.8) or higher.
 *
 * Layer 2 (SECONDARY, ship-blocking when data exists): eval_candidates replay.
 *   Stream rows from `eval_candidates` where tool_name='query' (the closest
 *   shape to whoknows queries the capture system has). For each, re-run
 *   findExperts and compute set-Jaccard@3 between current output and
 *   captured retrieved_slugs. Pass = REGRESSION_THRESHOLD (0.4) mean Jaccard.
 *
 *   Sparseness fallback: if fewer than MIN_REPLAY_ROWS (20) replay-eligible
 *   rows exist, regression gate auto-disables with stderr warning and exit
 *   is decided by Layer 1 alone.
 *
 * Exit codes:
 *   0 — both gates passed (or Layer 1 passed + Layer 2 skipped via sparseness)
 *   1 — at least one gate failed
 *   2 — config/usage error
 *
 * Output:
 *   --json     machine-readable JSON envelope
 *   default    human-readable table + verdict
 *
 * Usage:
 *   gbrain eval whoknows test/fixtures/whoknows-eval.jsonl
 *   gbrain eval whoknows test/fixtures/whoknows-eval.jsonl --json
 *   gbrain eval whoknows test/fixtures/whoknows-eval.jsonl --skip-replay
 */

import { readFileSync, existsSync } from 'fs';
import type { BrainEngine } from '../core/engine.ts';
import { findExperts } from './whoknows.ts';

export const HIT_RATE_THRESHOLD = 0.8;
export const REGRESSION_THRESHOLD = 0.4;
export const MIN_REPLAY_ROWS = 20;

export interface FixtureRow {
  query: string;
  expected_top_3_slugs: string[];
  notes?: string;
}

export interface QualityRowResult {
  query: string;
  expected: string[];
  actual_top_3: string[];
  hit: boolean;
}

export interface QualityReport {
  total: number;
  hits: number;
  hit_rate: number;
  threshold: number;
  passed: boolean;
  rows: QualityRowResult[];
}

export interface RegressionRowResult {
  query: string;
  captured: string[];
  current: string[];
  jaccard: number;
}

export interface RegressionReport {
  status: 'passed' | 'failed' | 'skipped';
  reason?: string; // populated when skipped
  total: number;
  mean_jaccard: number;
  threshold: number;
  rows: RegressionRowResult[];
}

export interface EvalWhoknowsReport {
  schema_version: 1;
  fixture_path: string;
  quality: QualityReport;
  regression: RegressionReport;
  overall_passed: boolean;
  exit_code: 0 | 1;
}

interface CliOpts {
  fixturePath?: string;
  json: boolean;
  skipReplay: boolean;
  limit: number;
  help: boolean;
}

function parseArgs(args: string[]): CliOpts {
  const opts: CliOpts = { json: false, skipReplay: false, limit: 5, help: false };
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') {
      opts.help = true;
      continue;
    }
    if (a === '--json') {
      opts.json = true;
      continue;
    }
    if (a === '--skip-replay') {
      opts.skipReplay = true;
      continue;
    }
    if (a === '--limit') {
      const n = parseInt(args[++i] ?? '', 10);
      if (Number.isFinite(n) && n > 0) opts.limit = n;
      continue;
    }
    if (a && !a.startsWith('--')) positional.push(a);
  }
  if (positional[0]) opts.fixturePath = positional[0];
  return opts;
}

const HELP = `Usage: gbrain eval whoknows <fixture.jsonl> [options]

Two-layer eval gate (v0.33 ENG-D2) for naive gbrain whoknows:
  Layer 1 (PRIMARY): hand-labeled fixture, pass at >= 80% top-3 hit rate
  Layer 2 (REGRESSION): eval_candidates replay set-Jaccard@3 >= 0.4
                        (auto-skipped if < 20 replay-eligible rows)

Fixture format (JSONL, one row per line):
  {"query": "lab automation", "expected_top_3_slugs": ["wiki/people/alice", "..."], "notes": "..."}

Options:
  --json              Emit JSON report instead of human-readable table
  --skip-replay       Skip Layer 2 entirely (run quality gate only)
  --limit N           Top-K to grade (default 5; eval uses top-3 by default)
  --help, -h          Show this help
`;

export function readFixture(path: string): FixtureRow[] {
  if (!existsSync(path)) {
    throw new Error(`fixture not found: ${path}`);
  }
  const raw = readFileSync(path, 'utf-8');
  const rows: FixtureRow[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('#')) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch (e) {
      throw new Error(`malformed JSONL line: ${trimmed.slice(0, 80)}`);
    }
    if (
      obj &&
      typeof obj === 'object' &&
      typeof (obj as Record<string, unknown>).query === 'string' &&
      Array.isArray((obj as Record<string, unknown>).expected_top_3_slugs)
    ) {
      const o = obj as Record<string, unknown>;
      const expected = (o.expected_top_3_slugs as unknown[]).filter(
        (s): s is string => typeof s === 'string',
      );
      const row: FixtureRow = {
        query: o.query as string,
        expected_top_3_slugs: expected,
      };
      if (typeof o.notes === 'string') row.notes = o.notes;
      rows.push(row);
    } else {
      throw new Error(`fixture row missing required fields (query, expected_top_3_slugs): ${trimmed.slice(0, 80)}`);
    }
  }
  return rows;
}

/**
 * Set-Jaccard@k between two slug lists, treating only the first k items
 * of each as the set. Empty intersection over empty union = 1.0 (vacuously
 * stable); empty intersection over non-empty union = 0.
 */
export function jaccardAtK(a: string[], b: string[], k = 3): number {
  const setA = new Set(a.slice(0, k));
  const setB = new Set(b.slice(0, k));
  if (setA.size === 0 && setB.size === 0) return 1;
  let intersect = 0;
  for (const x of setA) if (setB.has(x)) intersect++;
  const union = setA.size + setB.size - intersect;
  return union === 0 ? 1 : intersect / union;
}

export function topKHit(actual: string[], expected: string[], k = 3): boolean {
  const expectedSet = new Set(expected);
  for (let i = 0; i < Math.min(k, actual.length); i++) {
    if (expectedSet.has(actual[i])) return true;
  }
  return false;
}

async function runQualityGate(
  engine: BrainEngine,
  fixture: FixtureRow[],
  limit: number,
): Promise<QualityReport> {
  const rows: QualityRowResult[] = [];
  for (const row of fixture) {
    const results = await findExperts(engine, { topic: row.query, limit });
    const actualTop3 = results.slice(0, 3).map((r) => r.slug);
    rows.push({
      query: row.query,
      expected: row.expected_top_3_slugs,
      actual_top_3: actualTop3,
      hit: topKHit(actualTop3, row.expected_top_3_slugs, 3),
    });
  }
  const hits = rows.filter((r) => r.hit).length;
  const hit_rate = rows.length === 0 ? 0 : hits / rows.length;
  return {
    total: rows.length,
    hits,
    hit_rate,
    threshold: HIT_RATE_THRESHOLD,
    passed: hit_rate >= HIT_RATE_THRESHOLD,
    rows,
  };
}

interface ReplayRow {
  query: string;
  retrieved_slugs: string[];
}

/**
 * Stream captured query-shaped rows from eval_candidates. Limits to the
 * last 200 rows for tractable runtime; the regression layer is a
 * sanity check, not exhaustive scoring.
 */
async function loadReplayRows(engine: BrainEngine): Promise<ReplayRow[]> {
  try {
    const rows = await engine.executeRaw<{
      query: string;
      retrieved_slugs: string[] | string;
    }>(
      `SELECT query, retrieved_slugs
         FROM eval_candidates
         WHERE tool_name = 'query'
           AND query IS NOT NULL
           AND query <> ''
         ORDER BY id DESC
         LIMIT 200`,
    );
    return rows.map((r) => ({
      query: String(r.query),
      retrieved_slugs: Array.isArray(r.retrieved_slugs)
        ? r.retrieved_slugs
        : typeof r.retrieved_slugs === 'string'
          ? safeJsonArray(r.retrieved_slugs)
          : [],
    }));
  } catch (e) {
    // Table may not exist on installs where CONTRIBUTOR_MODE was never on.
    // Treat as "no replay data" for sparseness fallback.
    return [];
  }
}

function safeJsonArray(s: string): string[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

async function runRegressionGate(
  engine: BrainEngine,
  limit: number,
): Promise<RegressionReport> {
  const captured = await loadReplayRows(engine);
  if (captured.length < MIN_REPLAY_ROWS) {
    return {
      status: 'skipped',
      reason: `only ${captured.length} replay-eligible eval_candidates rows (< ${MIN_REPLAY_ROWS} threshold); GBRAIN_CONTRIBUTOR_MODE may have been off`,
      total: captured.length,
      mean_jaccard: 0,
      threshold: REGRESSION_THRESHOLD,
      rows: [],
    };
  }
  const rows: RegressionRowResult[] = [];
  for (const r of captured) {
    const current = await findExperts(engine, { topic: r.query, limit });
    const currentSlugs = current.slice(0, 3).map((x) => x.slug);
    rows.push({
      query: r.query,
      captured: r.retrieved_slugs.slice(0, 3),
      current: currentSlugs,
      jaccard: jaccardAtK(currentSlugs, r.retrieved_slugs, 3),
    });
  }
  const mean_jaccard = rows.reduce((s, x) => s + x.jaccard, 0) / Math.max(1, rows.length);
  return {
    status: mean_jaccard >= REGRESSION_THRESHOLD ? 'passed' : 'failed',
    total: rows.length,
    mean_jaccard,
    threshold: REGRESSION_THRESHOLD,
    rows,
  };
}

export async function runEvalWhoknows(
  engine: BrainEngine,
  args: string[],
): Promise<0 | 1 | 2> {
  const opts = parseArgs(args);
  if (opts.help) {
    console.log(HELP);
    return 0;
  }
  if (!opts.fixturePath) {
    console.error('gbrain eval whoknows: fixture path required');
    console.error(HELP);
    return 2;
  }

  let fixture: FixtureRow[];
  try {
    fixture = readFixture(opts.fixturePath);
  } catch (e: unknown) {
    console.error(`gbrain eval whoknows: ${(e as Error).message}`);
    return 2;
  }
  if (fixture.length === 0) {
    console.error('gbrain eval whoknows: fixture file is empty');
    return 2;
  }

  const quality = await runQualityGate(engine, fixture, opts.limit);
  const regression = opts.skipReplay
    ? {
        status: 'skipped' as const,
        reason: '--skip-replay flag',
        total: 0,
        mean_jaccard: 0,
        threshold: REGRESSION_THRESHOLD,
        rows: [],
      }
    : await runRegressionGate(engine, opts.limit);

  const regressionPassed = regression.status !== 'failed';
  const overall = quality.passed && regressionPassed;

  const report: EvalWhoknowsReport = {
    schema_version: 1,
    fixture_path: opts.fixturePath,
    quality,
    regression,
    overall_passed: overall,
    exit_code: overall ? 0 : 1,
  };

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    renderHumanReport(report);
  }
  return overall ? 0 : 1;
}

function renderHumanReport(r: EvalWhoknowsReport): void {
  console.log(`whoknows eval @ ${r.fixture_path}`);
  console.log('─'.repeat(60));
  console.log('');
  console.log('LAYER 1 — quality gate (hand-labeled fixture)');
  console.log(`  total: ${r.quality.total}`);
  console.log(`  hits:  ${r.quality.hits}`);
  console.log(`  rate:  ${(r.quality.hit_rate * 100).toFixed(1)}%  (threshold ${(r.quality.threshold * 100).toFixed(0)}%)`);
  console.log(`  ${r.quality.passed ? 'PASS' : 'FAIL'}`);
  if (!r.quality.passed) {
    console.log('');
    console.log('  Misses:');
    for (const row of r.quality.rows) {
      if (row.hit) continue;
      console.log(`    "${row.query}"`);
      console.log(`      expected: ${row.expected.join(', ')}`);
      console.log(`      got:      ${row.actual_top_3.join(', ') || '(no results)'}`);
    }
  }
  console.log('');
  console.log('LAYER 2 — regression gate (eval_candidates replay)');
  if (r.regression.status === 'skipped') {
    console.log(`  SKIPPED — ${r.regression.reason}`);
  } else {
    console.log(`  total:  ${r.regression.total}`);
    console.log(`  Jaccard mean: ${r.regression.mean_jaccard.toFixed(3)}  (threshold ${r.regression.threshold.toFixed(2)})`);
    console.log(`  ${r.regression.status === 'passed' ? 'PASS' : 'FAIL'}`);
  }
  console.log('');
  console.log(`VERDICT: ${r.overall_passed ? 'PASS' : 'FAIL'}`);
}
