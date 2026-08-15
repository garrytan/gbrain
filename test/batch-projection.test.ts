/**
 * v0.41 D4 — batch projection unit tests.
 *
 * Pure-function math; no DB or LLM needed. Pins the 4 critical contracts:
 *
 *   1. Cold-start fallback (no history → wide-guess with annotation)
 *   2. Unknown model → cost_estimate_unavailable tagged variant
 *   3. ±30% confidence band (or sample-stddev-derived when historical)
 *   4. Threshold gating respects env-var overrides
 *   5. Raise-cap hint fires only when lease cap is binding + meaningful speedup
 */

import { describe, test, expect } from 'bun:test';
import {
  projectBatch,
  formatProjection,
  shouldPromptAtThreshold,
  type RecentJobStats,
} from '../src/core/minions/batch-projection.ts';
import { withEnv } from './helpers/with-env.ts';

function coldStats(opts: Partial<RecentJobStats> = {}): RecentJobStats {
  return {
    sample_size: 0,
    effective_concurrency: 8,
    ...opts,
  };
}

function warmStats(opts: Partial<RecentJobStats> = {}): RecentJobStats {
  return {
    sample_size: 100,
    mean_latency_ms: 4000,
    mean_cost_usd: 0.03,
    stddev_cost_usd: 0.01,
    effective_concurrency: 8,
    ...opts,
  };
}

describe('projectBatch', () => {
  test('cold start: no history → cold_start=true with model-default cost guess', () => {
    const p = projectBatch({
      job_count: 100,
      model: 'anthropic:claude-sonnet-4-6',
      stats: coldStats(),
      current_lease_cap: 32,
    });
    expect(p.cold_start).toBe(true);
    expect(p.total_cost_usd).toBeGreaterThan(0);
    expect(p.total_duration_ms).toBeGreaterThan(0);
    // 100 jobs at concurrency=8, ~5s each → ≈63s.
    expect(p.effective_concurrency).toBe(8);
  });

  test('unknown model → unknown_model tagged variant, total_cost_usd=null', () => {
    const p = projectBatch({
      job_count: 100,
      model: 'mystery:foo-2',
      stats: coldStats(),
      current_lease_cap: 32,
    });
    expect(p.unknown_model).toBe('foo-2');
    expect(p.total_cost_usd).toBeNull();
    expect(p.cost_band_usd).toBeNull();
    // Duration is still computable from latency × jobs / concurrency.
    expect(p.total_duration_ms).toBeGreaterThan(0);
  });

  test('warm window with stddev → uses stddev-derived band (×1.96 ≈ 95%)', () => {
    const p = projectBatch({
      job_count: 100,
      model: 'anthropic:claude-sonnet-4-6',
      stats: warmStats({ mean_cost_usd: 0.05, stddev_cost_usd: 0.02 }),
      current_lease_cap: 32,
    });
    expect(p.cold_start).toBe(false);
    expect(p.total_cost_usd).toBeCloseTo(5.00, 2); // 100 × $0.05
    expect(p.cost_band_usd).toBeCloseTo(100 * 0.02 * 1.96, 1); // ≈ $3.92
  });

  test('warm window without stddev → blanket ±30% band', () => {
    const p = projectBatch({
      job_count: 100,
      model: 'anthropic:claude-sonnet-4-6',
      stats: warmStats({ stddev_cost_usd: undefined, mean_cost_usd: 0.05 }),
      current_lease_cap: 32,
    });
    expect(p.cost_band_usd).toBeCloseTo(p.total_cost_usd! * 0.30, 2);
  });

  test('effective_concurrency clamps to min(seen, lease_cap)', () => {
    const p = projectBatch({
      job_count: 100,
      model: 'anthropic:claude-sonnet-4-6',
      stats: warmStats({ effective_concurrency: 16 }),
      current_lease_cap: 4, // tighter than seen
    });
    expect(p.effective_concurrency).toBe(4);
  });

  test('raise_cap_hint fires when lease is binding AND a 4x raise meaningfully helps', () => {
    const p = projectBatch({
      job_count: 1000,
      model: 'anthropic:claude-sonnet-4-6',
      stats: warmStats({
        effective_concurrency: 32, // seen lots; lease is the constraint
        lease_headroom: 0.05, // hot — nearly saturated
      }),
      current_lease_cap: 8,
    });
    expect(p.raise_cap_hint).toBeDefined();
    expect(p.raise_cap_hint).toContain('GBRAIN_ANTHROPIC_MAX_INFLIGHT');
  });

  test('no raise_cap_hint when not binding', () => {
    const p = projectBatch({
      job_count: 100,
      model: 'anthropic:claude-sonnet-4-6',
      stats: warmStats({ lease_headroom: 0.8 }), // plenty of room
      current_lease_cap: 32,
    });
    expect(p.raise_cap_hint).toBeUndefined();
  });

  test('no raise_cap_hint when already at the ceiling', () => {
    const p = projectBatch({
      job_count: 100,
      model: 'anthropic:claude-sonnet-4-6',
      stats: warmStats({ lease_headroom: 0.05 }),
      current_lease_cap: 128, // at ceiling
    });
    expect(p.raise_cap_hint).toBeUndefined();
  });

  describe('v0.41.20.0 — slash-prefix model id routing (THE FIX)', () => {
    test('slash-form anthropic/claude-sonnet-4-6 strips to bare name + pricing hits', () => {
      // Pre-fix: inline bareModel(model) only handled `:`; slash-form fell
      // through to the unknown_model branch silently. Post-fix: parseModelId
      // handles both forms; pricing lookup succeeds; cold-start path produces
      // a non-null cost estimate.
      const p = projectBatch({
        job_count: 100,
        model: 'anthropic/claude-sonnet-4-6',
        stats: { sample_size: 0, effective_concurrency: 4 },
        current_lease_cap: 32,
      });
      expect(p.unknown_model).toBeUndefined();
      expect(p.total_cost_usd).not.toBeNull();
      expect(p.total_cost_usd).toBeGreaterThan(0);
    });

    test('double-separator openrouter:anthropic/X → unknown_model branch fires', () => {
      // Per D2: colon wins; tail is `anthropic/claude-sonnet-4-6` which
      // doesn't match ANTHROPIC_PRICING keys. Confirms the deliberate
      // OpenRouter-out-of-scope posture is observable downstream.
      const p = projectBatch({
        job_count: 100,
        model: 'openrouter:anthropic/claude-sonnet-4-6',
        stats: { sample_size: 0, effective_concurrency: 4 },
        current_lease_cap: 32,
      });
      expect(p.unknown_model).toBe('anthropic/claude-sonnet-4-6');
      expect(p.total_cost_usd).toBeNull();
    });
  });
});

describe('formatProjection', () => {
  test('known model: prints cost + duration + bands', () => {
    const s = formatProjection({
      total_duration_ms: 600_000, // 10 min
      total_cost_usd: 2.40,
      cost_band_usd: 0.72,
      duration_band_ms: 180_000,
      effective_concurrency: 8,
      cold_start: false,
    });
    expect(s).toContain('$2.40');
    expect(s).toContain('±$0.72');
    expect(s).toContain('10min');
    expect(s).toContain('concurrency=8');
    expect(s).not.toContain('no history');
  });

  test('cold start: includes annotation', () => {
    const s = formatProjection({
      total_duration_ms: 600_000,
      total_cost_usd: 2.40,
      cost_band_usd: 0.72,
      duration_band_ms: 180_000,
      effective_concurrency: 8,
      cold_start: true,
    });
    expect(s).toContain('no history');
    expect(s).toContain('wide guess');
  });

  test('unknown model: replaces cost section with explanation', () => {
    const s = formatProjection({
      total_duration_ms: 600_000,
      total_cost_usd: null,
      cost_band_usd: null,
      duration_band_ms: 180_000,
      effective_concurrency: 8,
      cold_start: true,
      unknown_model: 'foo-2',
    });
    expect(s).toContain('cost estimate unavailable');
    expect(s).toContain('foo-2');
    expect(s).toContain('pricing maps');
  });

  test('raise-cap hint surfaces inline', () => {
    const s = formatProjection({
      total_duration_ms: 600_000,
      total_cost_usd: 2.40,
      cost_band_usd: 0.72,
      duration_band_ms: 180_000,
      effective_concurrency: 8,
      cold_start: false,
      raise_cap_hint: 'raise GBRAIN_ANTHROPIC_MAX_INFLIGHT to 32 to finish in ~3min',
    });
    expect(s).toContain('raise GBRAIN_ANTHROPIC_MAX_INFLIGHT to 32');
  });
});

describe('shouldPromptAtThreshold', () => {
  test('prompts at >$5 default threshold', () => {
    expect(
      shouldPromptAtThreshold({
        total_duration_ms: 60_000,
        total_cost_usd: 5.01,
        cost_band_usd: 1,
        duration_band_ms: 10_000,
        effective_concurrency: 8,
        cold_start: false,
      }),
    ).toBe(true);
  });

  test('prompts at >30min default threshold', () => {
    expect(
      shouldPromptAtThreshold({
        total_duration_ms: 31 * 60_000,
        total_cost_usd: 0.50,
        cost_band_usd: 0.10,
        duration_band_ms: 60_000,
        effective_concurrency: 8,
        cold_start: false,
      }),
    ).toBe(true);
  });

  test('does NOT prompt below both thresholds', () => {
    expect(
      shouldPromptAtThreshold({
        total_duration_ms: 60_000,
        total_cost_usd: 2.00,
        cost_band_usd: 0.50,
        duration_band_ms: 10_000,
        effective_concurrency: 8,
        cold_start: false,
      }),
    ).toBe(false);
  });

  test('env var GBRAIN_BATCH_PROMPT_THRESHOLD_USD lowers the prompt floor', async () => {
    await withEnv({ GBRAIN_BATCH_PROMPT_THRESHOLD_USD: '1' }, async () => {
      expect(
        shouldPromptAtThreshold({
          total_duration_ms: 60_000,
          total_cost_usd: 1.50,
          cost_band_usd: 0.20,
          duration_band_ms: 10_000,
          effective_concurrency: 8,
          cold_start: false,
        }),
      ).toBe(true);
    });
  });
});
