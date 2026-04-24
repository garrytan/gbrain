/**
 * Scenario S12 — Acceptance pack refuses pass without baseline, fails on
 * regression.
 *
 * Falsifies E1: "Baselines must be captured before a phase claims improvement
 * over current behavior. A phase is not accepted because it 'feels better';
 * it is accepted because the measured contract improves without violating
 * boundary rules."
 *
 * This test calls the pure acceptance evaluator directly instead of spawning
 * the bench binary, to avoid the 5s subprocess timeout that caused the
 * original PR #36 CI failure.
 */

import { describe, expect, test } from 'bun:test';
import {
  evaluateLongitudinalAcceptance,
  type Phase8LongitudinalPhaseSummary,
} from '../../scripts/bench/phase8-longitudinal-evaluation.ts';

function buildPhaseSummaries(
  overrides: Partial<Record<string, Phase8LongitudinalPhaseSummary['comparable_status']>> = {},
): Phase8LongitudinalPhaseSummary[] {
  const phases = ['phase1', 'phase2', 'phase3', 'phase4', 'phase5', 'phase6', 'phase7'] as const;
  const baselineFamily: Record<string, string> = {
    phase1: 'repeated_work',
    phase2: 'markdown_retrieval',
    phase3: 'context_map',
    phase4: 'scope_isolation',
    phase5: 'governance',
    phase6: 'derived_governance',
    phase7: 'provenance_and_validity',
  };

  return phases.map((phase) => {
    const comparable = overrides[phase] ?? 'pass';
    const phaseStatus: Phase8LongitudinalPhaseSummary['phase_status'] =
      comparable === 'fail' ? 'fail'
      : comparable === 'pending_baseline' ? 'pending_baseline'
      : 'pass';
    return {
      phase,
      baseline_family: baselineFamily[phase]!,
      readiness_status: 'pass',
      comparable_status: comparable,
      phase_status: phaseStatus,
      acceptance_notes: [],
      regression_reasons: comparable === 'fail' ? ['p95_regression'] : [],
      source_manifest: [],
    } as unknown as Phase8LongitudinalPhaseSummary;
  });
}

describe('S12 — acceptance gated by baseline and regression', () => {
  test('all phases pass → readiness=pass, phase8_status=pass', async () => {
    const result = evaluateLongitudinalAcceptance(buildPhaseSummaries());
    expect(result.readiness_status).toBe('pass');
    expect(result.phase8_status).toBe('pass');
  });

  test('any phase pending_baseline → phase8_status=pending_baseline', async () => {
    const result = evaluateLongitudinalAcceptance(
      buildPhaseSummaries({ phase1: 'pending_baseline' }),
    );
    expect(result.phase8_status).toBe('pending_baseline');
  });

  test('any phase fail (regression detected) → phase8_status=fail (E1 enforced)', async () => {
    const result = evaluateLongitudinalAcceptance(
      buildPhaseSummaries({ phase2: 'fail' }),
    );
    expect(result.phase8_status).toBe('fail');
    expect(result.readiness_status).toBe('fail');
  });

  test('regression beats pending_baseline: a mixed state reports fail, not pending', async () => {
    const result = evaluateLongitudinalAcceptance(
      buildPhaseSummaries({ phase1: 'pending_baseline', phase3: 'fail' }),
    );
    expect(result.phase8_status).toBe('fail');
  });
});
