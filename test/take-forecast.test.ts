/**
 * v0.36.1.0 (T10 / E5) — Brier-trend forecasting tests.
 *
 * Hermetic. Pure-function tests + mock-engine path. No real LLM, no DB.
 *
 * Tests cover:
 *  - computeForecast: insufficient_data when bucket_n < MIN_BUCKET_N
 *  - computeForecast: stable forecast when bucket_n >= MIN_BUCKET_N
 *  - resolveDomainPrefix: slug-prefix-looking → kept, free-form → undefined
 *  - forecastForTake: routes through engine.getScorecard with proper args
 *  - batchForecast: caches per (holder, domain) tuple → minimal engine calls
 *  - exposes overall_brier alongside bucket_brier for comparison messaging
 */

import { describe, test, expect } from 'bun:test';
import {
  computeForecast,
  resolveDomainPrefix,
  forecastForTake,
  batchForecast,
  MIN_BUCKET_N,
} from '../src/core/calibration/take-forecast.ts';
import type { BrainEngine, TakesScorecard } from '../src/core/engine.ts';

function buildScorecard(opts: { resolved: number; brier: number | null }): TakesScorecard {
  return {
    total_bets: opts.resolved + 2,
    resolved: opts.resolved,
    correct: Math.floor(opts.resolved * 0.6),
    incorrect: Math.floor(opts.resolved * 0.3),
    partial: 0,
    accuracy: 0.6,
    brier: opts.brier,
    partial_rate: 0,
  };
}

interface ScorecardCall {
  holder: string | undefined;
  domainPrefix: string | undefined;
}

function buildMockEngine(opts: {
  scorecards: Record<string, TakesScorecard>; // key = `${holder}|${domainPrefix ?? ''}`
}): { engine: BrainEngine; calls: ScorecardCall[] } {
  const calls: ScorecardCall[] = [];
  const engine = {
    kind: 'pglite',
    async getScorecard(scOpts: { holder?: string; domainPrefix?: string }): Promise<TakesScorecard> {
      calls.push({ holder: scOpts.holder, domainPrefix: scOpts.domainPrefix });
      const key = `${scOpts.holder ?? ''}|${scOpts.domainPrefix ?? ''}`;
      return opts.scorecards[key] ?? buildScorecard({ resolved: 0, brier: null });
    },
  } as unknown as BrainEngine;
  return { engine, calls };
}

// ─── computeForecast (pure) ─────────────────────────────────────────

describe('computeForecast', () => {
  test('insufficient_data when bucket has fewer than MIN_BUCKET_N resolved', () => {
    const overall = buildScorecard({ resolved: 20, brier: 0.18 });
    const bucket = buildScorecard({ resolved: 3, brier: 0.31 });
    const out = computeForecast({
      conviction: 0.7,
      domain: 'macro',
      overallScorecard: overall,
      bucketScorecard: bucket,
    });
    expect(out.insufficient_data).toBe(true);
    expect(out.predicted_brier).toBeNull();
    expect(out.bucket_n).toBe(3);
    expect(out.overall_brier).toBe(0.18);
  });

  test('stable forecast when bucket_n >= MIN_BUCKET_N', () => {
    const overall = buildScorecard({ resolved: 20, brier: 0.18 });
    const bucket = buildScorecard({ resolved: 7, brier: 0.31 });
    const out = computeForecast({
      conviction: 0.7,
      domain: 'macro',
      overallScorecard: overall,
      bucketScorecard: bucket,
    });
    expect(out.insufficient_data).toBe(false);
    expect(out.predicted_brier).toBe(0.31);
    expect(out.overall_brier).toBe(0.18);
    expect(out.bucket_domain).toBe('macro');
  });

  test('falls back to overall scorecard when no bucket provided', () => {
    const overall = buildScorecard({ resolved: 12, brier: 0.21 });
    const out = computeForecast({ conviction: 0.7, overallScorecard: overall });
    expect(out.bucket_domain).toBe('overall');
    expect(out.predicted_brier).toBe(0.21);
  });

  test(`MIN_BUCKET_N constant is exported (currently ${MIN_BUCKET_N})`, () => {
    expect(MIN_BUCKET_N).toBeGreaterThan(0);
  });
});

// ─── resolveDomainPrefix ────────────────────────────────────────────

describe('resolveDomainPrefix', () => {
  test('undefined → undefined', () => {
    expect(resolveDomainPrefix(undefined)).toBeUndefined();
  });

  test('empty / whitespace → undefined', () => {
    expect(resolveDomainPrefix('')).toBeUndefined();
    expect(resolveDomainPrefix('   ')).toBeUndefined();
  });

  test('slug-prefix value (trailing slash) → kept', () => {
    expect(resolveDomainPrefix('companies/')).toBe('companies/');
  });

  test('wiki-prefix value → kept', () => {
    expect(resolveDomainPrefix('wiki/macro')).toBe('wiki/macro');
  });

  test('free-form word → undefined (falls back to overall)', () => {
    expect(resolveDomainPrefix('macro tech')).toBeUndefined();
    expect(resolveDomainPrefix('geography')).toBeUndefined();
  });
});

// ─── forecastForTake ────────────────────────────────────────────────

describe('forecastForTake', () => {
  test('no domain → 1 engine call for overall scorecard', async () => {
    const { engine, calls } = buildMockEngine({
      scorecards: {
        'garry|': buildScorecard({ resolved: 12, brier: 0.21 }),
      },
    });
    const out = await forecastForTake(engine, { holder: 'garry', conviction: 0.7 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ holder: 'garry', domainPrefix: undefined });
    expect(out.bucket_domain).toBe('overall');
    expect(out.predicted_brier).toBe(0.21);
  });

  test('with slug-prefix domain → 2 engine calls (overall + bucket)', async () => {
    const { engine, calls } = buildMockEngine({
      scorecards: {
        'garry|': buildScorecard({ resolved: 20, brier: 0.18 }),
        'garry|companies/': buildScorecard({ resolved: 7, brier: 0.25 }),
      },
    });
    const out = await forecastForTake(engine, {
      holder: 'garry',
      conviction: 0.7,
      domain: 'companies/',
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.domainPrefix).toBe('companies/');
    expect(out.predicted_brier).toBe(0.25);
    expect(out.overall_brier).toBe(0.18);
  });

  test('free-form domain falls back to overall (1 engine call, undefined prefix)', async () => {
    const { engine, calls } = buildMockEngine({
      scorecards: { 'garry|': buildScorecard({ resolved: 12, brier: 0.21 }) },
    });
    const out = await forecastForTake(engine, {
      holder: 'garry',
      conviction: 0.7,
      domain: 'macro tech',
    });
    expect(calls).toHaveLength(1);
    expect(out.bucket_domain).toBe('macro tech');
  });
});

// ─── batchForecast (memo) ───────────────────────────────────────────

describe('batchForecast', () => {
  test('caches per (holder, domain) tuple — repeat queries collapse', async () => {
    const { engine, calls } = buildMockEngine({
      scorecards: {
        'garry|': buildScorecard({ resolved: 20, brier: 0.18 }),
        'garry|companies/': buildScorecard({ resolved: 7, brier: 0.25 }),
      },
    });
    const out = await batchForecast(engine, [
      { holder: 'garry', conviction: 0.7, domain: 'companies/' },
      { holder: 'garry', conviction: 0.8, domain: 'companies/' },
      { holder: 'garry', conviction: 0.5 },
    ]);
    expect(out).toHaveLength(3);
    // 2 unique queries: (garry, undefined) + (garry, companies/).
    // 3 input takes but cache collapses to 2 actual engine calls.
    expect(calls).toHaveLength(2);
  });

  test('different holders do NOT collapse', async () => {
    const { engine, calls } = buildMockEngine({
      scorecards: {
        'garry|': buildScorecard({ resolved: 10, brier: 0.2 }),
        'alice|': buildScorecard({ resolved: 5, brier: 0.18 }),
      },
    });
    await batchForecast(engine, [
      { holder: 'garry', conviction: 0.7 },
      { holder: 'alice', conviction: 0.6 },
    ]);
    expect(calls).toHaveLength(2);
  });
});
