/**
 * Trends helpers tests — write, load, render.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import {
  loadTrend,
  renderTrendChart,
  writeRunRow,
} from '../src/core/eval-contradictions/trends.ts';
import type { ProbeReport } from '../src/core/eval-contradictions/types.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

function mkReport(runId: string, overrides: Partial<ProbeReport> = {}): ProbeReport {
  return {
    schema_version: 1,
    run_id: runId,
    judge_model: 'anthropic:claude-haiku-4-5',
    prompt_version: '2',
    truncation_policy: '1500-chars-utf8-safe',
    top_k: 5,
    sampling: 'deterministic',
    queries_evaluated: 50,
    queries_with_contradiction: 12,
    queries_with_any_finding: 18,
    total_contradictions_flagged: 18,
    verdict_breakdown: {
      no_contradiction: 200,
      contradiction: 12,
      temporal_supersession: 4,
      temporal_regression: 1,
      temporal_evolution: 1,
      negation_artifact: 0,
    },
    calibration: {
      queries_total: 50,
      queries_judged_clean: 38,
      queries_with_contradiction: 12,
      wilson_ci_95: { point: 0.24, lower: 0.14, upper: 0.37 },
    },
    judge_errors: {
      parse_fail: 0, refusal: 0, timeout: 0, http_5xx: 0, unknown: 0, total: 0,
      note: 'errors counted toward denominator',
    },
    cost_usd: { judge: 1.0, embedding: 0.005, total: 1.005, estimate_note: 'approx' },
    cache: { hits: 50, misses: 100, hit_rate: 0.333 },
    duration_ms: 45000,
    source_tier_breakdown: { curated_vs_curated: 2, curated_vs_bulk: 11, bulk_vs_bulk: 5, other: 0 },
    per_query: [],
    hot_pages: [],
    ...overrides,
  };
}

describe('writeRunRow', () => {
  test('persists a run from a ProbeReport', async () => {
    const inserted = await writeRunRow(engine, mkReport('test-run-1'), 45000);
    expect(inserted).toBe(true);
    const rows = await loadTrend(engine, 30);
    expect(rows.length).toBe(1);
    expect(rows[0].run_id).toBe('test-run-1');
    expect(rows[0].wilson_ci_lower).toBeCloseTo(0.14, 5);
  });

  test('idempotent on duplicate run_id', async () => {
    await writeRunRow(engine, mkReport('dup'), 100);
    const second = await writeRunRow(engine, mkReport('dup'), 100);
    expect(second).toBe(false);
  });

  test('flattens nested structures into top-level columns', async () => {
    await writeRunRow(
      engine,
      mkReport('shape-check', {
        queries_with_contradiction: 20,
        calibration: {
          queries_total: 100,
          queries_judged_clean: 80,
          queries_with_contradiction: 20,
          wilson_ci_95: { point: 0.2, lower: 0.13, upper: 0.29 },
        },
      }),
      777,
    );
    const rows = await loadTrend(engine, 30);
    expect(rows[0].queries_with_contradiction).toBe(20);
    expect(rows[0].duration_ms).toBe(777);
    expect(rows[0].wilson_ci_upper).toBeCloseTo(0.29, 5);
  });
});

describe('loadTrend', () => {
  test('newest first', async () => {
    await writeRunRow(engine, mkReport('old'), 100);
    await new Promise((r) => setTimeout(r, 10));
    await writeRunRow(engine, mkReport('new'), 100);
    const rows = await loadTrend(engine, 30);
    expect(rows[0].run_id).toBe('new');
    expect(rows[1].run_id).toBe('old');
  });

  test('empty when no runs exist', async () => {
    const rows = await loadTrend(engine, 30);
    expect(rows).toEqual([]);
  });

  test('parses source_tier_breakdown back to typed object', async () => {
    await writeRunRow(
      engine,
      mkReport('tier-check', {
        source_tier_breakdown: { curated_vs_curated: 99, curated_vs_bulk: 0, bulk_vs_bulk: 0, other: 0 },
      }),
      100,
    );
    const rows = await loadTrend(engine, 30);
    expect(rows[0].source_tier_breakdown.curated_vs_curated).toBe(99);
  });
});

describe('renderTrendChart', () => {
  test('empty input prints a friendly message, not an empty table', () => {
    const out = renderTrendChart([]);
    expect(out).toContain('No contradiction-probe runs');
    expect(out).toContain('gbrain eval suspected-contradictions');
  });

  test('single row produces a header + one data row', () => {
    const out = renderTrendChart([
      {
        run_id: 'r1',
        ran_at: '2026-05-11T00:00:00Z',
        judge_model: 'anthropic:claude-haiku-4-5',
        queries_evaluated: 50,
        queries_with_contradiction: 12,
        total_contradictions_flagged: 18,
        wilson_ci_lower: 0.14,
        wilson_ci_upper: 0.37,
        judge_errors_total: 0,
        cost_usd_total: 1.0,
        duration_ms: 45000,
        source_tier_breakdown: { curated_vs_curated: 0, curated_vs_bulk: 0, bulk_vs_bulk: 0, other: 0 },
        report_json: mkReport('r-test'),
      },
    ]);
    expect(out).toContain('Date');
    expect(out).toContain('2026-05-11');
    expect(out).toContain('claude-haiku-4-5');
  });

  test('multi-row chart has fully-filled bar for the max-value row', () => {
    const rows = [
      {
        run_id: 'big',
        ran_at: '2026-05-11T00:00:00Z',
        judge_model: 'anthropic:claude-haiku-4-5',
        queries_evaluated: 50,
        queries_with_contradiction: 25,
        total_contradictions_flagged: 100,
        wilson_ci_lower: 0.4, wilson_ci_upper: 0.6,
        judge_errors_total: 0, cost_usd_total: 5, duration_ms: 60000,
        source_tier_breakdown: { curated_vs_curated: 0, curated_vs_bulk: 0, bulk_vs_bulk: 0, other: 0 },
        report_json: mkReport('r-test'),
      },
      {
        run_id: 'small',
        ran_at: '2026-05-10T00:00:00Z',
        judge_model: 'anthropic:claude-haiku-4-5',
        queries_evaluated: 50,
        queries_with_contradiction: 1,
        total_contradictions_flagged: 5,
        wilson_ci_lower: 0.0, wilson_ci_upper: 0.1,
        judge_errors_total: 0, cost_usd_total: 1, duration_ms: 30000,
        source_tier_breakdown: { curated_vs_curated: 0, curated_vs_bulk: 0, bulk_vs_bulk: 0, other: 0 },
        report_json: mkReport('r-test'),
      },
    ];
    const out = renderTrendChart(rows);
    const lines = out.split('\n');
    const bigLine = lines.find((l) => l.includes('2026-05-11'));
    const smallLine = lines.find((l) => l.includes('2026-05-10'));
    expect(bigLine).toBeTruthy();
    expect(smallLine).toBeTruthy();
    // Big run gets fully-filled bar; small run gets a near-empty bar.
    const bigFill = (bigLine!.match(/#/g) ?? []).length;
    const smallFill = (smallLine!.match(/#/g) ?? []).length;
    expect(bigFill).toBeGreaterThan(smallFill);
  });
});
