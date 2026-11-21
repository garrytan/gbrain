/**
 * v0.35.4 — `gbrain founder scorecard` CLI (T7) tests.
 *
 * Pins:
 *   - Pure compute fn: each of the four rollup fields produces correct math.
 *   - JSON envelope has schema_version: 1 + every required field (R5).
 *   - G2: empty entity (no facts, no takes) returns a valid empty rollup
 *         with no NaN / nulls in numeric slots.
 *   - Red flags fire for regressions + high drift + missed predictions.
 */

import { describe, test, expect } from 'bun:test';
import { computeFounderScorecard } from '../src/commands/founder-scorecard.ts';
import type { TrajectoryPoint, Take } from '../src/core/engine.ts';
import { detectRegressions } from '../src/core/trajectory.ts';

function pt(args: {
  id: number;
  metric: string;
  value: number;
  date: string;
  emb?: Float32Array | null;
}): TrajectoryPoint {
  return {
    fact_id: args.id,
    valid_from: new Date(args.date),
    valid_until: null,
    metric: args.metric,
    value: args.value,
    unit: 'USD',
    period: 'monthly',
    event_type: null,
    text: `${args.metric} = ${args.value}`,
    source_session: null,
    source_markdown_slug: null,
    embedding: args.emb ?? null,
  };
}

function take(args: {
  id: number;
  claim: string;
  resolved_outcome: boolean | null;
}): Take {
  return {
    id: args.id,
    page_id: 1,
    page_slug: 'companies/acme-example',
    row_num: args.id,
    claim: args.claim,
    kind: 'fact',
    holder: 'self',
    weight: 0.9,
    since_date: '2026-01-15',
    until_date: null,
    source: 'test',
    active: true,
    resolved_at: args.resolved_outcome === null ? null : '2026-06-01',
    resolved_outcome: args.resolved_outcome,
    resolved_value: null,
    resolved_unit: null,
    resolved_source: null,
    resolved_outcome_label: null,
    resolved_by: null,
    superseded_by: null,
    embedded_at: null,
    created_at: '2026-01-15',
    updated_at: '2026-01-15',
  } as unknown as Take;
}

describe('computeFounderScorecard — JSON envelope (R5)', () => {
  test('empty inputs → valid empty rollup, schema_version: 1, no NaN (G2)', () => {
    const sc = computeFounderScorecard({
      entitySlug: 'companies/empty',
      windowSince: '2025-05-17',
      windowUntil: '2026-05-17',
      points: [],
      takes: [],
    });
    expect(sc.schema_version).toBe(1);
    expect(sc.entity_slug).toBe('companies/empty');
    expect(sc.window.since).toBe('2025-05-17');
    expect(sc.window.until).toBe('2026-05-17');
    expect(sc.claim_accuracy.predicted).toBe(0);
    expect(sc.claim_accuracy.accurate).toBe(0);
    expect(sc.claim_accuracy.pct).toBeNull();
    expect(sc.consistency.score).toBeNull();
    expect(sc.consistency.metric_changes).toBe(0);
    expect(sc.consistency.typed_facts).toBe(0);
    expect(sc.growth_trajectory).toEqual([]);
    expect(sc.red_flags).toEqual([]);
    // No NaN slipped into numeric slots.
    expect(Number.isNaN(sc.claim_accuracy.predicted)).toBe(false);
    expect(Number.isNaN(sc.consistency.metric_changes)).toBe(false);
  });
});

describe('computeFounderScorecard — claim_accuracy', () => {
  test('3 takes, 1 accurate, 1 missed, 1 unresolved → 1/2 = 50% over RESOLVED only', () => {
    const sc = computeFounderScorecard({
      entitySlug: 'companies/acme-example',
      windowSince: null, windowUntil: null,
      points: [],
      takes: [
        take({ id: 1, claim: 'will hit $1M ARR', resolved_outcome: true  }),
        take({ id: 2, claim: 'will close X',     resolved_outcome: false }),
        take({ id: 3, claim: 'might do Y',       resolved_outcome: null  }),
      ],
    });
    expect(sc.claim_accuracy.predicted).toBe(2);
    expect(sc.claim_accuracy.accurate).toBe(1);
    expect(sc.claim_accuracy.pct).toBeCloseTo(0.5, 3);
  });
});

describe('computeFounderScorecard — consistency + growth_trajectory', () => {
  test('3-point stable trajectory → 0 changes, score 1.0, growth direction matches latest delta', () => {
    const sc = computeFounderScorecard({
      entitySlug: 'companies/stable',
      windowSince: null, windowUntil: null,
      points: [
        pt({ id: 1, metric: 'mrr', value: 100, date: '2026-01-15' }),
        pt({ id: 2, metric: 'mrr', value: 101, date: '2026-04-12' }),
        pt({ id: 3, metric: 'mrr', value: 102, date: '2026-07-08' }),
      ],
      takes: [],
    });
    // 1% deltas are below the 5% change threshold.
    expect(sc.consistency.metric_changes).toBe(0);
    expect(sc.consistency.typed_facts).toBe(3);
    expect(sc.consistency.score).toBeCloseTo(1.0, 3);
    expect(sc.growth_trajectory.length).toBe(1);
    expect(sc.growth_trajectory[0].metric).toBe('mrr');
    // 101 → 102 = 0.99% delta < 1% threshold → 'flat'.
    expect(sc.growth_trajectory[0].direction).toBe('flat');
  });

  test('trajectory with one big drop → 1 change, score 0.667, direction down', () => {
    const sc = computeFounderScorecard({
      entitySlug: 'companies/declining',
      windowSince: null, windowUntil: null,
      points: [
        pt({ id: 1, metric: 'mrr', value: 200000, date: '2026-04-12' }),
        pt({ id: 2, metric: 'mrr', value: 150000, date: '2026-07-08' }),
        pt({ id: 3, metric: 'mrr', value: 150500, date: '2026-09-01' }),
      ],
      takes: [],
    });
    expect(sc.consistency.metric_changes).toBe(1);
    expect(sc.consistency.typed_facts).toBe(3);
    expect(sc.consistency.score).toBeCloseTo(1 - 1 / 3, 3);
    expect(sc.growth_trajectory[0].direction).toBe('flat'); // last delta is tiny
  });

  test('multiple metrics: each gets its own growth entry, alphabetically ordered', () => {
    const sc = computeFounderScorecard({
      entitySlug: 'companies/multi',
      windowSince: null, windowUntil: null,
      points: [
        pt({ id: 1, metric: 'mrr', value: 100, date: '2026-01-15' }),
        pt({ id: 2, metric: 'arr', value: 1200, date: '2026-01-15' }),
        pt({ id: 3, metric: 'mrr', value: 130, date: '2026-04-12' }),
        pt({ id: 4, metric: 'arr', value: 1500, date: '2026-04-12' }),
      ],
      takes: [],
    });
    expect(sc.growth_trajectory.map(g => g.metric)).toEqual(['arr', 'mrr']);
    expect(sc.growth_trajectory[0].direction).toBe('up');  // arr +25%
    expect(sc.growth_trajectory[1].direction).toBe('up');  // mrr +30%
  });
});

describe('computeFounderScorecard — red_flags', () => {
  test('regression fires a red flag', () => {
    const sc = computeFounderScorecard({
      entitySlug: 'companies/regression',
      windowSince: null, windowUntil: null,
      points: [
        pt({ id: 1, metric: 'mrr', value: 200000, date: '2026-04-12' }),
        pt({ id: 2, metric: 'mrr', value: 150000, date: '2026-07-08' }),
      ],
      takes: [],
    });
    const reg = sc.red_flags.find(f => f.kind === 'regression');
    expect(reg).toBeDefined();
    expect(reg!.metric).toBe('mrr');
    expect(reg!.text).toContain('25.0%');
  });

  test('missed predictions surface as red flags', () => {
    const sc = computeFounderScorecard({
      entitySlug: 'companies/missed',
      windowSince: null, windowUntil: null,
      points: [],
      takes: [
        take({ id: 1, claim: 'predicted X by June, did not hit it', resolved_outcome: false }),
      ],
    });
    const missed = sc.red_flags.find(f => f.kind === 'missed_prediction');
    expect(missed).toBeDefined();
    expect(missed!.text).toContain('did not hit it');
  });

  test('high drift score (>=0.5) fires a narrative_drift flag', () => {
    function v(i: number): Float32Array {
      const a = new Float32Array(8);
      a[i % 8] = 1.0;
      return a;
    }
    const sc = computeFounderScorecard({
      entitySlug: 'companies/drift',
      windowSince: null, windowUntil: null,
      points: [
        pt({ id: 1, metric: 'mrr', value: 100, date: '2026-01-15', emb: v(0) }),
        pt({ id: 2, metric: 'mrr', value: 101, date: '2026-04-12', emb: v(3) }),
        pt({ id: 3, metric: 'mrr', value: 102, date: '2026-07-08', emb: v(6) }),
      ],
      takes: [],
    });
    const drift = sc.red_flags.find(f => f.kind === 'narrative_drift');
    expect(drift).toBeDefined();
  });

  test('clean trajectory + accurate takes + low drift = zero red flags', () => {
    function v(): Float32Array {
      const a = new Float32Array(8);
      a[0] = 1.0;
      return a;
    }
    const sc = computeFounderScorecard({
      entitySlug: 'companies/clean',
      windowSince: null, windowUntil: null,
      points: [
        pt({ id: 1, metric: 'mrr', value: 100, date: '2026-01-15', emb: v() }),
        pt({ id: 2, metric: 'mrr', value: 110, date: '2026-04-12', emb: v() }),
        pt({ id: 3, metric: 'mrr', value: 120, date: '2026-07-08', emb: v() }),
      ],
      takes: [
        take({ id: 1, claim: 'accurate prediction', resolved_outcome: true }),
      ],
    });
    expect(sc.red_flags).toEqual([]);
  });
});

describe('computeFounderScorecard — growth delta on negative-valued metrics', () => {
  test('a net_income loss shrinking from -100000 to -50000 reads up, +50%', () => {
    const sc = computeFounderScorecard({
      entitySlug: 'companies/acme-example',
      windowSince: null, windowUntil: null,
      points: [
        pt({ id: 1, metric: 'net_income', value: -100000, date: '2026-01-01' }),
        pt({ id: 2, metric: 'net_income', value: -50000, date: '2026-02-01' }),
      ],
      takes: [],
    });
    expect(sc.growth_trajectory).toEqual([
      { metric: 'net_income', direction: 'up', latest_delta_pct: 0.5 },
    ]);
  });

  test('a net_income loss deepening from -50000 to -100000 reads down, -100%', () => {
    const sc = computeFounderScorecard({
      entitySlug: 'companies/acme-example',
      windowSince: null, windowUntil: null,
      points: [
        pt({ id: 1, metric: 'net_income', value: -50000, date: '2026-01-01' }),
        pt({ id: 2, metric: 'net_income', value: -100000, date: '2026-02-01' }),
      ],
      takes: [],
    });
    expect(sc.growth_trajectory).toEqual([
      { metric: 'net_income', direction: 'down', latest_delta_pct: -1 },
    ]);
  });

  test('growth delta agrees with the regression delta on the same loss (abs denominator)', () => {
    const points = [
      pt({ id: 1, metric: 'net_income', value: -50000, date: '2026-01-01' }),
      pt({ id: 2, metric: 'net_income', value: -100000, date: '2026-02-01' }),
    ];
    const sc = computeFounderScorecard({
      entitySlug: 'companies/acme-example', windowSince: null, windowUntil: null, points, takes: [],
    });
    const regression = detectRegressions(points);
    expect(regression).toHaveLength(1);
    expect(sc.growth_trajectory[0].latest_delta_pct).toBe(regression[0].delta_pct);
  });
});

// A drop on a lower-is-better metric (churn, burn ...) is an improvement, a rise is the red flag.
describe('computeFounderScorecard — lower-is-better metrics', () => {
  function card(points: TrajectoryPoint[]) {
    return computeFounderScorecard({
      entitySlug: 'companies/acme-example', windowSince: null, windowUntil: null, points, takes: [],
    });
  }
  const churn = (id: number, value: number, date: string) => ({ ...pt({ id, metric: 'churn', value, date }), unit: 'pct' });

  test('falling churn 5 -> 3 pct raises no red flag', () => {
    const sc = card([churn(1, 5, '2026-01-01'), churn(2, 3, '2026-02-01')]);
    expect(sc.red_flags).toEqual([]);
    // growth_trajectory stays a plain numeric direction: churn fell, so it reads down.
    expect(sc.growth_trajectory).toEqual([{ metric: 'churn', direction: 'down', latest_delta_pct: -0.4 }]);
  });

  test('rising burn 150000 -> 200000 USD is a regression red flag that says it rose', () => {
    const sc = card([
      pt({ id: 1, metric: 'burn', value: 150000, date: '2026-01-01' }),
      pt({ id: 2, metric: 'burn', value: 200000, date: '2026-02-01' }),
    ]);
    expect(sc.red_flags).toEqual([
      { kind: 'regression', metric: 'burn', text: 'burn rose 33.3% (2026-01-01 → 2026-02-01)' },
    ]);
  });

  test('falling ARR 200000 -> 150000 USD is still a regression red flag that says it fell', () => {
    const sc = card([
      pt({ id: 1, metric: 'arr', value: 200000, date: '2026-01-01' }),
      pt({ id: 2, metric: 'arr', value: 150000, date: '2026-02-01' }),
    ]);
    expect(sc.red_flags).toEqual([
      { kind: 'regression', metric: 'arr', text: 'arr fell 25.0% (2026-01-01 → 2026-02-01)' },
    ]);
  });
});

// A loss stored as a negative number is a loss of that size: a deeper loss is a rise.
describe('computeFounderScorecard — signed lower-is-better values', () => {
  test('a net_loss that turns from -50000 into a profit raises no red flag', () => {
    const card = computeFounderScorecard({
      entitySlug: 'companies/acme-example', windowSince: null, windowUntil: null, takes: [],
      points: [
        pt({ id: 1, metric: 'net_loss', value: -50000, date: '2026-01-01' }),
        pt({ id: 2, metric: 'net_loss', value: 100000, date: '2026-02-01' }),
      ],
    });
    expect(card.red_flags).toEqual([]);
  });

  test('a net_loss that goes -50000 -> 100000 -> -50000 raises a red flag for the return to a loss', () => {
    const c = computeFounderScorecard({
      entitySlug: 'companies/acme-example', windowSince: null, windowUntil: null, takes: [],
      points: [
        pt({ id: 1, metric: 'net_loss', value: -50000, date: '2026-01-01' }),
        pt({ id: 2, metric: 'net_loss', value: 100000, date: '2026-02-01' }),
        pt({ id: 3, metric: 'net_loss', value: -50000, date: '2026-03-01' }),
      ],
    });
    expect(c.red_flags).toHaveLength(1);
    expect(c.red_flags[0].text).toContain('net_loss rose');
  });

  test('a benefit_cost_ratio that falls 2 -> 1 is a red flag and a rise is not', () => {
    const run = (a: number, b: number) => computeFounderScorecard({
      entitySlug: 'companies/acme-example', windowSince: null, windowUntil: null, takes: [],
      points: [
        pt({ id: 1, metric: 'benefit_cost_ratio', value: a, date: '2026-01-01' }),
        pt({ id: 2, metric: 'benefit_cost_ratio', value: b, date: '2026-02-01' }),
      ],
    }).red_flags;
    expect(run(2, 1)).toHaveLength(1);
    expect(run(2, 1)[0].text).toContain('benefit_cost_ratio fell');
    expect(run(1, 2)).toEqual([]);
  });

  function card(metric: string, a: number, b: number) {
    return computeFounderScorecard({
      entitySlug: 'companies/acme-example', windowSince: null, windowUntil: null, takes: [],
      points: [
        pt({ id: 1, metric, value: a, date: '2026-01-01' }),
        pt({ id: 2, metric, value: b, date: '2026-02-01' }),
      ],
    });
  }

  test('a net_loss deepening from -50000 to -100000 is a red flag that says it rose', () => {
    expect(card('net_loss', -50000, -100000).red_flags).toEqual([
      { kind: 'regression', metric: 'net_loss', text: 'net_loss rose 100.0% (2026-01-01 → 2026-02-01)' },
    ]);
  });

  test('a net_loss shrinking from -100000 to -50000 raises no red flag', () => {
    expect(card('net_loss', -100000, -50000).red_flags).toEqual([]);
  });

  test('a debt_service_coverage_ratio falling from 2 to 1 is a red flag that says it fell', () => {
    expect(card('debt_service_coverage_ratio', 2, 1).red_flags).toEqual([
      { kind: 'regression', metric: 'debt_service_coverage_ratio', text: 'debt_service_coverage_ratio fell 50.0% (2026-01-01 → 2026-02-01)' },
    ]);
  });
});

// Savings and recovery metrics hold a lower-is-better word but are good news going up.
describe('computeFounderScorecard — savings and recovery metrics', () => {
  function card(metric: string, a: number, b: number) {
    return computeFounderScorecard({
      entitySlug: 'companies/acme-example', windowSince: null, windowUntil: null, takes: [],
      points: [
        pt({ id: 1, metric, value: a, date: '2026-01-01' }),
        pt({ id: 2, metric, value: b, date: '2026-02-01' }),
      ],
    });
  }

  test('a rise in cost_savings raises no red flag', () => {
    expect(card('cost_savings', 100000, 150000).red_flags).toEqual([]);
  });

  test('a rise in revenue_loss_recovered raises no red flag', () => {
    expect(card('revenue_loss_recovered', 40000, 60000).red_flags).toEqual([]);
  });

  test('a falling cost_savings is a regression red flag that says it fell', () => {
    expect(card('cost_savings', 150000, 100000).red_flags).toEqual([
      { kind: 'regression', metric: 'cost_savings', text: 'cost_savings fell 33.3% (2026-01-01 → 2026-02-01)' },
    ]);
  });
});
