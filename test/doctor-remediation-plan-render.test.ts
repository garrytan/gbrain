// Regression coverage for the `gbrain doctor --remediation-plan` verdict
// contradiction: when the brain was below target AND the target was
// unreachable, the human renderer printed "Target unreachable: max with
// autonomous remediation is N/100" followed immediately by "No
// remediations needed. Brain is at target." — two consecutive lines that
// contradicted each other and hid the real next step.

import { describe, test, expect } from 'bun:test';
import { renderRemediationPlanLines } from '../src/commands/doctor.ts';

type Plan = Parameters<typeof renderRemediationPlanLines>[0];

function planFixture(overrides: Partial<Plan>): Plan {
  return {
    brain_score_current: 0,
    target_unreachable: false,
    max_reachable_score: 100,
    plan: [],
    est_total_seconds: 0,
    est_total_usd_cost: 0,
    blocked: [],
    ...overrides,
  };
}

describe('renderRemediationPlanLines', () => {
  test('unreachable + brain below target — never claims "Brain is at target"', () => {
    const plan = planFixture({
      brain_score_current: 45,
      target_unreachable: true,
      max_reachable_score: 70,
      plan: [],
      blocked: [{ check: 'link_density', reason: 'no enrichment keys configured' }],
    });
    const text = renderRemediationPlanLines(plan, 90).join('\n');
    expect(text).toContain('Brain score: 45/100');
    expect(text).toContain('Target unreachable: max with autonomous remediation is 70/100');
    expect(text).not.toContain('Brain is at target');
    expect(text).toContain('Blocked checks');
  });

  test('reachable, brain at or above target, no plan — emits the "at target" line', () => {
    const plan = planFixture({
      brain_score_current: 95,
      target_unreachable: false,
      max_reachable_score: 100,
      plan: [],
    });
    const text = renderRemediationPlanLines(plan, 90).join('\n');
    expect(text).toContain('Brain is at target');
    expect(text).not.toContain('Target unreachable');
  });

  test('brain at exact target with empty plan — still "at target"', () => {
    const plan = planFixture({
      brain_score_current: 90,
      target_unreachable: false,
      plan: [],
    });
    const text = renderRemediationPlanLines(plan, 90).join('\n');
    expect(text).toContain('Brain is at target');
  });

  test('brain below target with plan steps — lists the plan, no "at target" line', () => {
    const plan = planFixture({
      brain_score_current: 60,
      target_unreachable: false,
      max_reachable_score: 100,
      est_total_seconds: 120,
      est_total_usd_cost: 0.4,
      plan: [
        { step: 1, severity: 'high', job: 'embed-coverage', rationale: 'missing embeddings' },
        { step: 2, severity: 'med', job: 'consolidate', rationale: 'pending entity merges', est_usd_cost: 0.4 },
      ],
    });
    const lines = renderRemediationPlanLines(plan, 90);
    const text = lines.join('\n');
    expect(text).toContain('Plan: 2 step(s)');
    expect(text).toContain('1. [high] embed-coverage');
    expect(text).toContain('2. [med] consolidate');
    expect(text).toContain('($0.40)');
    expect(text).not.toContain('Brain is at target');
  });

  test('unreachable but a partial plan exists — plan prints, "at target" suppressed', () => {
    const plan = planFixture({
      brain_score_current: 30,
      target_unreachable: true,
      max_reachable_score: 55,
      est_total_seconds: 90,
      est_total_usd_cost: 0.2,
      plan: [
        { step: 1, severity: 'high', job: 'embed-coverage', rationale: 'reach max_reachable' },
      ],
      blocked: [{ check: 'enrichment', reason: 'no provider key configured' }],
    });
    const text = renderRemediationPlanLines(plan, 90).join('\n');
    expect(text).toContain('Target unreachable: max with autonomous remediation is 55/100');
    expect(text).toContain('Plan: 1 step(s)');
    expect(text).toContain('Blocked checks');
    expect(text).not.toContain('Brain is at target');
  });
});
