import { describe, it, expect } from 'bun:test';
import { DEFAULT_BUDGET_USD } from '../../src/core/cycle/extract-atoms.ts';

// autopilot's auto-drain bounds the brain-wide daily job count as
// floor(autopilot.auto_drain.max_usd_per_day / <per-run cap>). That per-run cap
// used to be a private `PER_RUN_USD = 0.3` copy of the drain's default. Once an
// operator set `cycle.extract_atoms.budget_usd`, the two silently diverged: the
// daily count was computed from a cost the drain no longer charged.
//
// These pin the arithmetic and the exported default the two sites now share.
const dailyJobs = (maxUsdPerDay: number, perRunUsd: number) =>
  perRunUsd > 0 ? Math.max(0, Math.floor(maxUsdPerDay / perRunUsd)) : 0;

describe('auto-drain daily job count derives from the drain’s own budget cap', () => {
  it('exports the drain default so autopilot cannot carry a stale copy', () => {
    expect(DEFAULT_BUDGET_USD).toBe(0.3);
  });

  it('matches the historical count when the cap is left at the default', () => {
    // Regression guard: unchanged behavior for operators who never set the key.
    expect(dailyJobs(2.0, DEFAULT_BUDGET_USD)).toBe(6);
  });

  it('scales the daily count when the operator lowers the per-run cap', () => {
    // The bug: a 0.10 cap still yielded 6 (floor(2.0/0.30)) instead of 20.
    expect(dailyJobs(2.0, 0.1)).toBe(20);
    expect(dailyJobs(2.0, 0.1)).not.toBe(dailyJobs(2.0, DEFAULT_BUDGET_USD));
  });

  it('scales down when the operator raises the per-run cap', () => {
    expect(dailyJobs(2.0, 1.0)).toBe(2);
  });

  it('dispatches nothing rather than dividing by zero on a zero cap', () => {
    expect(dailyJobs(2.0, 0)).toBe(0);
    expect(Number.isFinite(dailyJobs(2.0, 0))).toBe(true);
  });

  it('dispatches nothing when the daily budget is below one run', () => {
    expect(dailyJobs(0.05, DEFAULT_BUDGET_USD)).toBe(0);
  });
});
